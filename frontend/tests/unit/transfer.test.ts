import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSessionKey } from '../../src/crypto';
import { createSession } from '../../src/session';
import { FileTransfer, WINDOW_BYTES, type TransferFile } from '../../src/transfer';
import type { DownloadSink } from '../../src/download';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 0;
  onmessage?: (event: { data: ArrayBuffer }) => void;
  onclose?: () => void;
  onerror?: () => void;
  other!: Channel;
  sent = 0;
  send(data: ArrayBuffer) {
    this.sent++;
    queueMicrotask(() => { if (this.other.readyState === 'open') this.other.onmessage?.({ data }); });
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    this.onclose?.();
    this.other.close();
  }
}

const sessions: FileTransfer[] = [];
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); });

async function pair(sink: DownloadSink) {
  const key = await importSessionKey(createSession().key);
  const a = new Channel(), b = new Channel();
  a.other = b; b.other = a;
  const sent = new Map<string, TransferFile>(), received = new Map<string, TransferFile>();
  const ready = vi.fn(), error = vi.fn();
  const download = vi.fn(async () => sink);
  const sender = new FileTransfer(a as unknown as RTCDataChannel, key, 'test', 'sender', { ready, error, file: file => sent.set(file.id, file) });
  const receiver = new FileTransfer(b as unknown as RTCDataChannel, key, 'test', 'receiver', { ready, error, file: file => received.set(file.id, file) }, download);
  sessions.push(sender, receiver);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
  return { sender, receiver, a, b, sent, received, error, download };
}

function sink(): DownloadSink {
  return { started: Promise.resolve(), write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn() };
}

// A virtual source permits exercising large metadata without allocating the file.
function source(size: number) {
  return { name: 'large.bin', size, slice: vi.fn((start: number, end: number) => new Blob([new Uint8Array(Math.min(end, size) - start)])) } as unknown as File & { slice: ReturnType<typeof vi.fn> };
}

describe('streamed file protocol', () => {
  it('offers files above 10 GiB without reading data, and continues after a decline', async () => {
    const target = sink();
    const p = await pair(target);
    const large = source(100 * 1024 ** 3);
    const sending = p.sender.sendFiles([large, new File(['ok'], 'small.txt')]);
    await vi.waitFor(() => expect([...p.received.values()][0]?.size).toBe(100 * 1024 ** 3));
    expect(large.slice).not.toHaveBeenCalled();
    expect(p.download).not.toHaveBeenCalled();
    await p.receiver.declineFile([...p.received.keys()][0]);
    await vi.waitFor(() => expect(p.received.size).toBe(2));
    await p.receiver.acceptFile([...p.received.keys()][1]);
    await sending;
    expect([...p.sent.values()].map(file => file.status)).toEqual(['declined', 'complete']);
    expect(target.write).toHaveBeenCalledTimes(1);
    expect(p.error).not.toHaveBeenCalled();
  });

  it('waits for the actual browser download to start before sending bytes', async () => {
    let start!: () => void;
    const target = sink();
    target.started = new Promise<void>(resolve => { start = resolve; });
    const p = await pair(target);
    const file = source(1);
    const sending = p.sender.sendFiles([file]);
    await vi.waitFor(() => expect(p.received.size).toBe(1));
    const accepting = p.receiver.acceptFile([...p.received.keys()][0]);
    await vi.waitFor(() => expect(p.download).toHaveBeenCalledOnce());
    expect(file.slice).not.toHaveBeenCalled();
    start();
    await accepting;
    await sending;
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('bounds sender read-ahead while disk output stalls, then resumes without losing bytes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let bytes = 0;
    const target = sink();
    target.write = vi.fn(async chunk => { await blocked; bytes += chunk.length; });
    const p = await pair(target);
    const file = source(3 * WINDOW_BYTES + 17);
    const sending = p.sender.sendFiles([file]);
    void sending.catch(() => {});
    await vi.waitFor(() => expect(p.received.size).toBe(1));
    await p.receiver.acceptFile([...p.received.keys()][0]);
    await vi.waitFor(() => expect(file.slice.mock.calls.length).toBeGreaterThan(63));
    const read = file.slice.mock.calls.reduce((sum, [start, end]) => sum + end - start, 0);
    expect(read).toBeLessThanOrEqual(WINDOW_BYTES);
    expect(target.write).toHaveBeenCalledTimes(1);
    expect(bytes).toBe(0);
    release();
    await sending;
    expect(bytes).toBe(file.size);
    expect(p.error).not.toHaveBeenCalled();
  });

  it('unblocks pending file acceptance on disconnect', async () => {
    const p = await pair(sink());
    const sending = p.sender.sendFiles([source(100 * 1024 ** 3)]);
    const rejected = expect(sending).rejects.toThrow('ended');
    await vi.waitFor(() => expect(p.received.size).toBe(1));
    p.receiver.dispose();
    await rejected;
    expect([...p.sent.values()][0].status).toBe('failed');
  });

  it('rejects a peer flooding the encrypted receive queue', async () => {
    const p = await pair(sink());
    for (let i = 0; i < 40; i++) p.b.onmessage?.({ data: new ArrayBuffer(64 * 1024) });
    expect(p.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('receive buffer') }));
    expect(p.b.readyState).toBe('closed');
  });
});
