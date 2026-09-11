import { decrypt, encrypt } from './crypto';
import { opposite, type Role } from './session';

export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024 - 64;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const enum Frame { Hello = 1, Start, Chunk, End, Ack }

export type TransferFile = {
  id: string; name: string; size: number; bytes: number;
  status: 'queued' | 'sending' | 'receiving' | 'complete' | 'failed';
  downloadUrl?: string;
};

type Callbacks = { ready: () => void; file: (file: TransferFile) => void; error: (error: Error) => void };
type Incoming = { file: TransferFile; parts: ArrayBuffer[] };

export class FileTransfer {
  private sendSequence = 0;
  private receiveSequence = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private sentHello = false;
  private receivedHello = false;
  private stopped = false;
  private busy = false;
  private sentBytes = 0;
  private receivedBytes = 0;
  private incoming?: Incoming;
  private active?: TransferFile;
  private pendingAck?: { id: string; resolve: () => void; reject: (error: Error) => void };
  private lastProgress = 0;

  constructor(
    private channel: RTCDataChannel,
    private key: CryptoKey,
    private context: string,
    private role: Role,
    private callbacks: Callbacks,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onmessage = event => {
      this.receiveQueue = this.receiveQueue.then(() => this.receive(event.data)).catch(error => this.fail(error));
    };
    channel.onclose = () => this.fail(new Error('Your peer disconnected. Create a new link to reconnect.'));
    channel.onerror = () => this.fail(new Error('The file connection failed. Create a new link and try again.'));
    void this.send(Frame.Hello, encoder.encode(JSON.stringify({ protocol: 1, role }))).then(() => {
      this.sentHello = true;
      this.maybeReady();
    }).catch(error => this.fail(error));
  }

  private maybeReady() {
    if (this.sentHello && this.receivedHello && !this.stopped) this.callbacks.ready();
  }

  private async waitForCapacity() {
    if (this.stopped || this.channel.readyState !== 'open') throw new Error('The peer connection is closed.');
    if (this.channel.bufferedAmount <= HIGH_WATER) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.channel.removeEventListener('bufferedamountlow', drained);
        this.channel.removeEventListener('close', closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('The peer connection closed during transfer.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Transfer stalled. Create a new link and try again.')); }, 30_000);
      this.channel.addEventListener('bufferedamountlow', drained);
      this.channel.addEventListener('close', closed);
      if (this.channel.readyState !== 'open') closed();
      else if (this.channel.bufferedAmount <= LOW_WATER) drained();
    });
  }

  private send(type: Frame, payload = new Uint8Array()): Promise<void> {
    const task = this.sendQueue.then(async () => {
      if (this.stopped) throw new Error('The transfer has ended.');
      if (this.sendSequence > 0xffffffff) throw new Error('Create a new link to continue transferring.');
      const frame = new Uint8Array(5 + payload.length);
      frame[0] = type;
      new DataView(frame.buffer).setUint32(1, this.sendSequence++);
      frame.set(payload, 5);
      const ciphertext = await encrypt(this.key, frame, `${this.context}:${this.role}`);
      await this.waitForCapacity();
      this.channel.send(ciphertext);
    });
    this.sendQueue = task;
    return task;
  }

  private async receive(data: unknown) {
    if (this.stopped) return;
    if (!(data instanceof ArrayBuffer) || data.byteLength > 64 * 1024) throw new Error('Invalid file-transfer message.');
    const plain = await decrypt(this.key, data, `${this.context}:${opposite(this.role)}`);
    if (this.stopped) return;
    if (plain.length < 5 || new DataView(plain.buffer).getUint32(1) !== this.receiveSequence++) {
      throw new Error('File data arrived out of order. Transfer stopped.');
    }
    const type = plain[0];
    const payload = plain.slice(5);
    if (type === Frame.Hello) {
      const hello = JSON.parse(decoder.decode(payload));
      if (this.receivedHello || hello.protocol !== 1 || hello.role !== opposite(this.role)) throw new Error('Unexpected peer handshake.');
      this.receivedHello = true;
      this.maybeReady();
      return;
    }
    if (!this.receivedHello) throw new Error('Peer verification is incomplete.');
    if (type === Frame.Ack) {
      if (this.role !== 'sender' || !this.pendingAck || decoder.decode(payload) !== this.pendingAck.id) {
        throw new Error('Unexpected file confirmation.');
      }
      this.pendingAck.resolve();
      this.pendingAck = undefined;
      return;
    }
    if (this.role !== 'receiver') throw new Error('Unexpected file from the receiving peer.');
    if (type === Frame.Start) {
      if (this.incoming) throw new Error('A file is already being received.');
      const meta = JSON.parse(decoder.decode(payload));
      if (typeof meta.id !== 'string' || meta.id.length > 64 || typeof meta.name !== 'string' || meta.name.length > 1024 ||
          !Number.isSafeInteger(meta.size) || meta.size < 0 || this.receivedBytes + meta.size > MAX_TRANSFER_BYTES) {
        throw new Error('Invalid file details or the 256 MB transfer limit was exceeded.');
      }
      this.receivedBytes += meta.size;
      this.incoming = { file: { id: meta.id, name: meta.name, size: meta.size, bytes: 0, status: 'receiving' }, parts: [] };
      this.callbacks.file({ ...this.incoming.file });
    } else if (type === Frame.Chunk) {
      if (!this.incoming || this.incoming.file.bytes + payload.byteLength > this.incoming.file.size) throw new Error('File size does not match its encrypted metadata.');
      this.incoming.parts.push(payload.buffer);
      this.incoming.file.bytes += payload.byteLength;
      this.progress(this.incoming.file);
    } else if (type === Frame.End) {
      if (!this.incoming || decoder.decode(payload) !== this.incoming.file.id || this.incoming.file.bytes !== this.incoming.file.size) {
        throw new Error('The received file is incomplete.');
      }
      const { file, parts } = this.incoming;
      const downloadUrl = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      this.callbacks.file({ ...file, status: 'complete', downloadUrl });
      this.incoming = undefined;
      await this.send(Frame.Ack, encoder.encode(file.id));
    } else {
      throw new Error('Unknown file-transfer message.');
    }
  }

  private progress(file: TransferFile) {
    const now = performance.now();
    if (now - this.lastProgress > 100 || file.bytes === file.size) {
      this.lastProgress = now;
      this.callbacks.file({ ...file });
    }
  }

  async sendFiles(files: File[]) {
    if (this.role !== 'sender' || !this.sentHello || !this.receivedHello || this.stopped) throw new Error('Wait until your peer is connected.');
    if (this.busy) throw new Error('Wait for the current files to finish sending.');
    if (!files.length) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (this.sentBytes + total > MAX_TRANSFER_BYTES) throw new Error('This link supports up to 256 MB in total. Choose fewer files or create a new link.');
    this.busy = true;
    this.sentBytes += total;
    const queue = files.map(file => ({ source: file, row: { id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, status: 'queued' } as TransferFile }));
    queue.forEach(({ row }) => this.callbacks.file({ ...row }));
    try {
      for (const { source, row } of queue) {
        this.active = row;
        row.status = 'sending';
        this.callbacks.file({ ...row });
        await this.send(Frame.Start, encoder.encode(JSON.stringify({ id: row.id, name: row.name, size: row.size })));
        for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) {
          const chunk = new Uint8Array(await source.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
          await this.send(Frame.Chunk, chunk);
          row.bytes += chunk.length;
          this.progress(row);
        }
        let ackTimer: ReturnType<typeof setTimeout>;
        const acknowledged = new Promise<void>((resolve, reject) => {
          this.pendingAck = { id: row.id, resolve, reject };
          ackTimer = setTimeout(() => reject(new Error('Your peer did not confirm receipt. Create a new link to retry.')), 30_000);
        });
        // Observe both promises immediately, including a disconnect while End is queued.
        try {
          await Promise.all([this.send(Frame.End, encoder.encode(row.id)), acknowledged]);
        } finally {
          clearTimeout(ackTimer!);
          this.pendingAck = undefined;
        }
        row.status = 'complete';
        this.callbacks.file({ ...row });
        this.active = undefined;
      }
    } catch (error) {
      for (const { row } of queue) if (row.status !== 'complete') this.callbacks.file({ ...row, status: 'failed' });
      this.fail(error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    this.dispose();
    this.callbacks.error(error instanceof Error ? error : new Error('File transfer failed.'));
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.incoming) this.callbacks.file({ ...this.incoming.file, status: 'failed' });
    if (this.active) this.callbacks.file({ ...this.active, status: 'failed' });
    this.incoming = undefined;
    this.pendingAck?.reject(new Error('The transfer has ended.'));
    this.channel.close();
  }
}
