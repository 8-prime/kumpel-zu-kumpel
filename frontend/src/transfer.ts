import { decrypt, encrypt } from './crypto';
import { createDownload, type DownloadSink } from './download';
import { opposite, type Role } from './session';

const CHUNK_BYTES = 16 * 1024 - 64;
export const WINDOW_BYTES = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const RECEIPT_INTERVAL = 64 * 1024;
const STALL_TIMEOUT = 120_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const enum Frame { Hello = 1, Start, Chunk, End, Ack, Accept, Decline, Progress }

export type TransferFile = {
  id: string; name: string; size: number; bytes: number;
  status: 'queued' | 'offered' | 'starting' | 'sending' | 'receiving' | 'complete' | 'declined' | 'failed';
};

type Callbacks = { ready: () => void; file: (file: TransferFile) => void; error: (error: Error) => void };
type Incoming = { file: TransferFile; sink?: DownloadSink; reported: number };
type Pending<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export class FileTransfer {
  private sendSequence = 0;
  private receiveSequence = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedFrames = 0;
  private sentHello = false;
  private receivedHello = false;
  private stopped = false;
  private busy = false;
  private incoming?: Incoming;
  private downloads = new Set<DownloadSink>();
  private active?: TransferFile;
  private decision?: Pending<boolean>;
  private receipt?: Pending<void>;
  private capacity?: Pending<void>;
  private acknowledgedBytes = 0;
  private lastProgress = 0;

  constructor(
    private channel: RTCDataChannel,
    private key: CryptoKey,
    private context: string,
    private role: Role,
    private callbacks: Callbacks,
    private download = createDownload,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onmessage = event => {
      if (this.stopped) return;
      const data = event.data;
      // Bound even the encrypted queue before async decryption/writes. A peer
      // that ignores receive credits must not exhaust the receiving tab.
      if (!(data instanceof ArrayBuffer) || data.byteLength > 64 * 1024 ||
          this.queuedBytes + data.byteLength > 2 * WINDOW_BYTES || this.queuedFrames >= 256) {
        this.fail(new Error('The peer exceeded the receive buffer. Transfer stopped.')); return;
      }
      this.queuedBytes += data.byteLength;
      this.queuedFrames++;
      this.receiveQueue = this.receiveQueue.then(() => this.receive(data)).catch(error => this.fail(error)).finally(() => {
        this.queuedBytes -= data.byteLength;
        this.queuedFrames--;
      });
    };
    channel.onclose = () => this.fail(new Error('Your peer disconnected. Create a new link to reconnect.'));
    channel.onerror = () => this.fail(new Error('The file connection failed. Create a new link and try again.'));
    void this.send(Frame.Hello, encoder.encode(JSON.stringify({ protocol: 2, role }))).then(() => {
      this.sentHello = true;
      this.maybeReady();
    }).catch(error => this.fail(error));
  }

  private maybeReady() {
    if (this.sentHello && this.receivedHello && !this.stopped) this.callbacks.ready();
  }

  private async waitForCapacity() {
    if (this.stopped || this.channel.readyState !== 'open') throw new Error('The peer connection is closed.');
    if (this.channel.bufferedAmount <= WINDOW_BYTES) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.channel.removeEventListener('bufferedamountlow', drained);
        this.channel.removeEventListener('close', closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('The peer connection closed during transfer.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Transfer stalled. Create a new link and try again.')); }, STALL_TIMEOUT);
      this.channel.addEventListener('bufferedamountlow', drained);
      this.channel.addEventListener('close', closed);
      if (this.channel.readyState !== 'open') closed();
      else if (this.channel.bufferedAmount <= LOW_WATER) drained();
    });
  }

  private async waitForCredit(nextBytes: number) {
    while (nextBytes > this.acknowledgedBytes + WINDOW_BYTES) {
      if (this.stopped) throw new Error('The transfer has ended.');
      const capacity = this.capacity = pending<void>();
      const timer = setTimeout(() => capacity.reject(new Error('Your peer stopped downloading. Create a new link to retry.')), STALL_TIMEOUT);
      try { await capacity.promise; }
      finally { clearTimeout(timer); if (this.capacity === capacity) this.capacity = undefined; }
    }
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

  private async receive(data: ArrayBuffer) {
    if (this.stopped) return;
    const plain = await decrypt(this.key, data, `${this.context}:${opposite(this.role)}`);
    if (this.stopped) return;
    if (plain.length < 5 || new DataView(plain.buffer).getUint32(1) !== this.receiveSequence++) {
      throw new Error('File data arrived out of order. Transfer stopped.');
    }
    const type = plain[0];
    const payload = plain.slice(5);
    if (type === Frame.Hello) {
      const hello = JSON.parse(decoder.decode(payload));
      if (this.receivedHello || hello.protocol !== 2 || hello.role !== opposite(this.role)) {
        throw new Error('Incompatible peer. Reload both pages and create a new link.');
      }
      this.receivedHello = true;
      this.maybeReady();
      return;
    }
    if (!this.receivedHello) throw new Error('Peer verification is incomplete.');
    if (this.role === 'sender') {
      if (type === Frame.Progress) {
        const update = JSON.parse(decoder.decode(payload));
        if (!this.active || this.active.status !== 'sending' || update.id !== this.active.id ||
            !Number.isSafeInteger(update.bytes) || update.bytes <= this.acknowledgedBytes || update.bytes > this.active.bytes) {
          throw new Error('Invalid download progress from your peer.');
        }
        this.acknowledgedBytes = update.bytes;
        this.capacity?.resolve();
      } else {
        if (!this.active || decoder.decode(payload) !== this.active.id) throw new Error('Unexpected file confirmation.');
        if ((type === Frame.Accept || type === Frame.Decline) && this.decision) {
          this.decision.resolve(type === Frame.Accept);
          this.decision = undefined;
        } else if (type === Frame.Ack && this.receipt) {
          this.receipt.resolve();
          this.receipt = undefined;
        } else throw new Error('Unexpected file confirmation.');
      }
      return;
    }
    if (type === Frame.Start) {
      if (this.incoming) throw new Error('A file is already being received.');
      const meta = JSON.parse(decoder.decode(payload));
      if (typeof meta.id !== 'string' || !meta.id.length || meta.id.length > 64 || typeof meta.name !== 'string' || meta.name.length > 1024 ||
          !Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error('Invalid file details.');
      this.incoming = { file: { id: meta.id, name: meta.name, size: meta.size, bytes: 0, status: 'offered' }, reported: 0 };
      this.callbacks.file({ ...this.incoming.file });
    } else if (type === Frame.Chunk) {
      const incoming = this.incoming;
      if (!incoming?.sink || incoming.file.status !== 'receiving' || !payload.length || payload.length > CHUNK_BYTES ||
          incoming.file.bytes + payload.length > incoming.file.size) throw new Error('Unexpected file data or size mismatch.');
      const length = payload.length;
      await incoming.sink.write(payload);
      if (this.stopped) return;
      incoming.file.bytes += length;
      this.progress(incoming.file);
      // Credit is returned only after the browser's download stream accepts data.
      if (incoming.file.bytes - incoming.reported >= RECEIPT_INTERVAL || incoming.file.bytes === incoming.file.size) {
        incoming.reported = incoming.file.bytes;
        await this.send(Frame.Progress, encoder.encode(JSON.stringify({ id: incoming.file.id, bytes: incoming.file.bytes })));
      }
    } else if (type === Frame.End) {
      const incoming = this.incoming;
      if (!incoming?.sink || incoming.file.status !== 'receiving' || decoder.decode(payload) !== incoming.file.id || incoming.file.bytes !== incoming.file.size) {
        throw new Error('The received file is incomplete.');
      }
      await incoming.sink.close();
      if (this.stopped) return;
      this.callbacks.file({ ...incoming.file, status: 'complete' });
      this.incoming = undefined;
      await this.send(Frame.Ack, encoder.encode(incoming.file.id));
    } else throw new Error('Unknown file-transfer message.');
  }

  async acceptFile(id: string) {
    const incoming = this.incoming;
    if (this.stopped || !incoming || incoming.file.id !== id || incoming.file.status !== 'offered') return;
    incoming.file.status = 'starting';
    this.callbacks.file({ ...incoming.file });
    try {
      const sink = await this.download(incoming.file.name, incoming.file.size, error => this.fail(error));
      if (this.stopped) { sink.abort(new Error('The transfer has ended.')); return; }
      this.downloads.add(sink);
      incoming.sink = sink;
      await sink.started;
      if (this.stopped) return;
      incoming.file.status = 'receiving';
      this.callbacks.file({ ...incoming.file });
      await this.send(Frame.Accept, encoder.encode(id));
    } catch (error) { this.fail(error); }
  }

  async declineFile(id: string) {
    const incoming = this.incoming;
    if (this.stopped || !incoming || incoming.file.id !== id || incoming.file.status !== 'offered') return;
    this.incoming = undefined;
    this.callbacks.file({ ...incoming.file, status: 'declined' });
    try { await this.send(Frame.Decline, encoder.encode(id)); }
    catch (error) { this.fail(error); }
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
    if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0 || file.name.length > 1024)) throw new Error('Invalid file details.');
    this.busy = true;
    const queue = files.map(file => ({ source: file, row: { id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, status: 'queued' } as TransferFile }));
    queue.forEach(({ row }) => this.callbacks.file({ ...row }));
    try {
      for (const { source, row } of queue) {
        this.active = row;
        row.status = 'offered';
        this.callbacks.file({ ...row });
        const decision = this.decision = pending<boolean>();
        await this.send(Frame.Start, encoder.encode(JSON.stringify({ id: row.id, name: row.name, size: row.size })));
        if (!await decision.promise) {
          row.status = 'declined';
          this.callbacks.file({ ...row });
          this.active = undefined;
          continue;
        }
        row.status = 'sending';
        this.acknowledgedBytes = 0;
        this.callbacks.file({ ...row });
        for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) {
          await this.waitForCredit(Math.min(offset + CHUNK_BYTES, source.size));
          const chunk = new Uint8Array(await source.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
          await this.send(Frame.Chunk, chunk);
          row.bytes += chunk.length;
          this.progress(row);
        }
        const receipt = this.receipt = pending<void>();
        const timer = setTimeout(() => receipt.reject(new Error('Your peer did not finish downloading. Create a new link to retry.')), STALL_TIMEOUT);
        try { await Promise.all([this.send(Frame.End, encoder.encode(row.id)), receipt.promise]); }
        finally { clearTimeout(timer); this.receipt = undefined; }
        row.status = 'complete';
        this.callbacks.file({ ...row });
        this.active = undefined;
      }
    } catch (error) {
      for (const { row } of queue) if (row.status !== 'complete' && row.status !== 'declined') this.callbacks.file({ ...row, status: 'failed' });
      this.fail(error);
      throw error;
    } finally { this.busy = false; }
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    this.dispose();
    this.callbacks.error(error instanceof Error ? error : new Error('File transfer failed.'));
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error('The transfer has ended.');
    this.downloads.forEach(sink => sink.abort(error));
    this.downloads.clear();
    if (this.incoming) {
      this.incoming.sink?.abort(error);
      this.callbacks.file({ ...this.incoming.file, status: 'failed' });
    }
    if (this.active) this.callbacks.file({ ...this.active, status: 'failed' });
    this.incoming = undefined;
    this.decision?.reject(error);
    this.receipt?.reject(error);
    this.capacity?.reject(error);
    this.channel.close();
  }
}
