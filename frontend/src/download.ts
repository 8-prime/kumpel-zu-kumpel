// Only this directory is controlled by the worker; app pages and signaling
// remain outside its scope. Download URLs contain random tokens, never keys.
const SCOPE = '/downloads/';
let registration: Promise<ServiceWorkerRegistration> | undefined;

export interface DownloadSink {
  started: Promise<void>;
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(error: Error): void;
}

export async function prepareDownloads(): Promise<ServiceWorkerRegistration> {
  if (!window.isSecureContext || !navigator.serviceWorker?.register || !window.ReadableStream || !window.MessageChannel) {
    throw new Error('Streaming downloads are unavailable in this browser. Open the link in a supported browser over HTTPS.');
  }
  if (!registration) {
    registration = (async () => {
      const result = await navigator.serviceWorker.register(`${SCOPE}sw.js`, { scope: SCOPE, updateViaCache: 'none' });
      if (result.active?.state === 'activated') return result;
      const worker = result.installing || result.waiting || result.active;
      if (!worker) throw new Error('Could not prepare streaming downloads. Reload this page and retry.');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
        const changed = () => {
          if (worker.state === 'activated') { cleanup(); resolve(); }
          else if (worker.state === 'redundant') { cleanup(); reject(new Error('Could not start streaming downloads. Reload this page.')); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Preparing downloads timed out. Reload this page.')); }, 15_000);
        worker.addEventListener('statechange', changed);
        changed();
      });
      return result;
    })().catch(error => { registration = undefined; throw error; });
  }
  return registration;
}

export async function createDownload(name: string, size: number, onError: (error: Error) => void): Promise<DownloadSink> {
  const worker = (await prepareDownloads()).active;
  if (!worker) throw new Error('The download worker is unavailable. Reload this page.');
  const token = crypto.randomUUID();
  const { port1: port, port2 } = new MessageChannel();
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'File download';
  frame.referrerPolicy = 'no-referrer';
  let error: Error | undefined;
  let finished = false;
  let demand = false;
  let pending: { chunk: Uint8Array<ArrayBuffer>; resolve: () => void; reject: (error: Error) => void } | undefined;
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // A cancellation can arrive before the caller starts waiting for either.
  void started.catch(() => {});
  void closed.catch(() => {});
  let lastPong = Date.now();
  const cleanup = (removeFrame = true) => {
    clearTimeout(startTimer);
    clearInterval(heartbeat);
    window.removeEventListener('pagehide', leaving);
    navigator.serviceWorker.removeEventListener('message', workerMessage);
    port.close();
    if (removeFrame) frame.remove();
  };
  const abort = (reason: Error, notify = false) => {
    if (finished) { frame.remove(); return; }
    if (error) return;
    error = reason;
    port.postMessage({ type: 'abort' });
    rejectStarted(reason);
    rejectClosed(reason);
    pending?.reject(reason);
    pending = undefined;
    cleanup();
    if (notify) onError(reason);
  };
  const leaving = () => abort(new Error('The receiving page closed.'));
  const workerMessage = (event: MessageEvent) => {
    if (event.source !== worker || event.data?.token !== token) return;
    if (event.data.type === 'pong') lastPong = Date.now();
    if (event.data.type === 'missing') abort(new Error('The browser stopped the download. Create a new link to retry.'), true);
  };
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 120_000) {
      abort(new Error('The browser stopped responding to the download. Create a new link to retry.'), true);
    } else {
      // A service-worker message event also keeps slow Firefox downloads alive.
      worker.postMessage({ type: 'ping', token });
    }
  }, 10_000);
  const startTimer = setTimeout(() => abort(new Error('The download did not start. Allow downloads for this site and retry.'), true), 60_000);
  const flush = () => {
    if (!demand || !pending || error) return;
    demand = false;
    const chunk = pending.chunk;
    port.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
  };
  port.onmessage = event => {
    if (error || finished) return;
    const message = event.data;
    if (message.type === 'ready') {
      frame.src = `${SCOPE}${token}`;
      document.body.append(frame);
    } else if (message.type === 'started') {
      clearTimeout(startTimer);
      resolveStarted();
    } else if (message.type === 'pull') {
      demand = true;
      flush();
    } else if (message.type === 'written') {
      pending?.resolve();
      pending = undefined;
    } else if (message.type === 'closed') {
      finished = true;
      resolveClosed();
      // Firefox may still be finishing its native download after the stream
      // closes. Keep the initiating frame until the transfer session is reset.
      cleanup(false);
    } else if (message.type === 'error') {
      abort(new Error(message.message || 'The download was cancelled.'), true);
    }
  };
  port.onmessageerror = () => abort(new Error('The download connection failed.'), true);
  window.addEventListener('pagehide', leaving);
  navigator.serviceWorker.addEventListener('message', workerMessage);
  worker.postMessage({ type: 'download', version: 1, token, name, size }, [port2]);
  return {
    started,
    write(chunk) {
      if (error) return Promise.reject(error);
      if (finished || pending) return Promise.reject(new Error('Unexpected download write.'));
      return new Promise<void>((resolve, reject) => { pending = { chunk, resolve, reject }; flush(); });
    },
    close() {
      if (error) return Promise.reject(error);
      if (!finished) port.postMessage({ type: 'end' });
      return closed;
    },
    abort,
  };
}
