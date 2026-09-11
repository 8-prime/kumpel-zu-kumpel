import { decrypt, encrypt, importSessionKey } from './crypto';
import { opposite, signalingUrl, type Session } from './session';
import { FileTransfer, type TransferFile } from './transfer';

export type ConnectionStatus = 'connecting' | 'waiting' | 'gathering' | 'negotiating' | 'verifying' | 'connected' | 'error';
type Callbacks = { status: (status: ConnectionStatus, error?: string) => void; file: (file: TransferFile) => void };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class PeerSession {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private transfer?: FileTransfer;
  private key?: CryptoKey;
  private connectionId?: string;
  private authenticated = false;
  private stopped = false;
  private remoteDescriptionReceived = false;
  private timer?: ReturnType<typeof setTimeout>;
  private gatherCancel?: () => void;
  private signalQueue: Promise<void> = Promise.resolve();

  constructor(private session: Session, private callbacks: Callbacks) {}

  async connect() {
    try {
      if (!window.isSecureContext || !crypto.subtle || !window.RTCPeerConnection) {
        throw new Error('Open this page over HTTPS or localhost in a browser that supports WebRTC.');
      }
      this.key = await importSessionKey(this.session.key);
      if (this.stopped) return;
      this.callbacks.status('connecting');
      this.ws = new WebSocket(signalingUrl(import.meta.env.VITE_SIGNALING_URL || location.origin, this.session));
      this.timer = setTimeout(() => this.fail(new Error('Could not reach the signaling server. Check that it is running, then retry.')), 12_000);
      this.ws.onopen = () => { clearTimeout(this.timer); this.callbacks.status('waiting'); };
      this.ws.onmessage = event => {
        this.signalQueue = this.signalQueue.then(() => this.handleSignal(event.data)).catch(error => this.fail(error));
      };
      this.ws.onerror = () => this.fail(new Error('Could not reach the signaling server. Check your connection and retry.'));
      this.ws.onclose = () => {
        if (!this.authenticated && !this.stopped) this.fail(new Error('The signaling connection closed before your peer connected. Create a new link to retry.'));
      };
    } catch (error) { this.fail(error); }
  }

  private sendSignal(message: unknown) {
    if (this.stopped || this.ws?.readyState !== WebSocket.OPEN) throw new Error('Signaling connection is unavailable.');
    this.ws.send(JSON.stringify(message));
  }

  private async handleSignal(raw: unknown) {
    if (this.stopped || this.authenticated) return;
    if (typeof raw !== 'string' || raw.length > 512 * 1024) throw new Error('Invalid signaling message.');
    const message = JSON.parse(raw);
    if (message.type === 'error') throw new Error(typeof message.message === 'string' ? message.message : 'The signaling server rejected the connection.');
    if (message.type === 'peer_left') throw new Error('Your peer left before connecting. Create a new link to try again.');
    if (message.type === 'start_stun') {
      if (this.pc) throw new Error('This session has already started. Create a new link to reconnect.');
      if (typeof message.stun_server !== 'string' || !/^stuns?:[^\s]+$/.test(message.stun_server)) throw new Error('The server supplied an invalid STUN address.');
      this.callbacks.status('gathering');
      this.timer = setTimeout(() => this.fail(new Error('A direct connection could not be established. Try another network; some networks require a TURN relay.')), 60_000);
      this.pc = new RTCPeerConnection({ iceServers: [{ urls: message.stun_server }] });
      this.pc.onconnectionstatechange = () => {
        if (this.pc?.connectionState === 'failed') this.fail(new Error('A direct connection failed. Try another network; some networks require a TURN relay.'));
        if (this.pc?.connectionState === 'disconnected' && this.authenticated) this.fail(new Error('Your peer disconnected. Create a new link to reconnect.'));
      };
      this.pc.ondatachannel = event => {
        if (this.session.role !== 'receiver' || event.channel.label !== 'files' || this.transfer) {
          event.channel.close();
          this.fail(new Error('Unexpected peer data channel.'));
          return;
        }
        this.attachChannel(event.channel);
      };
      if (this.session.role === 'sender') {
        this.connectionId = crypto.randomUUID();
        this.attachChannel(this.pc.createDataChannel('files', { ordered: true }));
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await this.sendDescription();
      }
    } else if (message.type === 'receive_peer_information') {
      if (!this.pc || !this.key || this.remoteDescriptionReceived) throw new Error('Unexpected peer connection information.');
      if (!Array.isArray(message.data) || message.data.length > 64 * 1024 || message.data.some((b: unknown) => !Number.isInteger(b) || Number(b) < 0 || Number(b) > 255)) throw new Error('Invalid peer connection information.');
      const plaintext = await decrypt(this.key, Uint8Array.from(message.data).buffer, this.signalContext(opposite(this.session.role)));
      if (this.stopped) return;
      const information = JSON.parse(decoder.decode(plaintext));
      const expectedType = this.session.role === 'sender' ? 'answer' : 'offer';
      if (information.description?.type !== expectedType || typeof information.description.sdp !== 'string' ||
          typeof information.connectionId !== 'string' || information.connectionId.length !== 36) throw new Error('Invalid WebRTC description.');
      if (this.session.role === 'sender' && information.connectionId !== this.connectionId) throw new Error('Peer response does not belong to this connection.');
      this.connectionId = information.connectionId;
      this.remoteDescriptionReceived = true;
      this.callbacks.status('negotiating');
      await this.pc.setRemoteDescription(information.description);
      if (this.session.role === 'receiver') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.sendDescription();
      }
    } else {
      throw new Error('The signaling server sent an unsupported command.');
    }
  }

  private signalContext(role: string) { return `kumpel-v1:${this.session.id}:signaling:${role}`; }

  private async sendDescription() {
    const pc = this.pc!;
    // Non-trickle ICE: gather candidates into the SDP and relay one opaque payload.
    // If a STUN server is slow, use candidates already found after 12 seconds.
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); this.gatherCancel = undefined; resolve(); };
        const changed = () => { if (pc.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 12_000);
        this.gatherCancel = done;
        pc.addEventListener('icegatheringstatechange', changed);
        if (pc.iceGatheringState === 'complete') done();
      });
    }
    if (this.stopped) return;
    const data = encoder.encode(JSON.stringify({ connectionId: this.connectionId, description: pc.localDescription?.toJSON() }));
    const encrypted = await encrypt(this.key!, data, this.signalContext(this.session.role));
    if (this.stopped) return;
    this.sendSignal({ type: 'peer_information', data: Array.from(new Uint8Array(encrypted)) });
    this.callbacks.status('negotiating');
  }

  private attachChannel(channel: RTCDataChannel) {
    let openedOnce = false;
    const opened = () => {
      // A received channel may already be open when ondatachannel fires, with
      // its open event still queued. Initialize the encrypted stream only once.
      if (openedOnce) return;
      openedOnce = true;
      if (this.stopped) { channel.close(); return; }
      if (!this.connectionId || !this.key || this.transfer) { this.fail(new Error('Unexpected data channel state.')); return; }
      this.callbacks.status('verifying');
      this.transfer = new FileTransfer(channel, this.key, `kumpel-v1:${this.session.id}:files:${this.connectionId}`, this.session.role, {
        file: file => this.callbacks.file(file),
        error: error => this.fail(error),
        ready: () => {
          if (this.authenticated || this.stopped) return;
          this.authenticated = true;
          clearTimeout(this.timer);
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ready' }));
            this.ws.close(1000, 'p2p-ready');
          }
          this.callbacks.status('connected');
        },
      });
    };
    channel.onopen = opened;
    if (channel.readyState === 'open') opened();
  }

  async sendFiles(files: File[]) {
    if (!this.transfer || !this.authenticated) throw new Error('Wait until your peer is connected.');
    await this.transfer.sendFiles(files);
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    const message = error instanceof Error ? error.message : 'The connection failed. Create a new link to retry.';
    this.dispose();
    this.callbacks.status('error', message);
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.gatherCancel?.();
    this.transfer?.dispose();
    this.pc?.close();
    this.ws?.close();
  }
}
