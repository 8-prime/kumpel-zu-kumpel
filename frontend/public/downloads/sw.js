/* Local streaming downloads. No file cache, storage, external host, or network
 * fallback: an expired/unrecognised download URL always fails locally. */
const transfers = new Map();
const prefix = new URL(self.registration.scope).pathname;
// New workers wait for existing clients/transfers; never replace a live stream.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  const data = event.data;
  const client = event.source;
  if (!client || new URL(client.url).origin !== self.location.origin) return;
  if (data?.type === 'ping') {
    const entry = transfers.get(data.token);
    if (entry?.clientId === client.id) entry.touch();
    client.postMessage({ type: entry?.clientId === client.id ? 'pong' : 'missing', token: data.token });
    return;
  }
  const port = event.ports[0];
  if (!port || data?.type !== 'download') return;
  if (data.version !== 1 || !/^[a-f0-9-]{36}$/.test(data.token) || transfers.has(data.token) ||
      typeof data.name !== 'string' || data.name.length > 1024 || !Number.isSafeInteger(data.size) || data.size < 0) {
    port.postMessage({ type: 'error', message: 'Invalid download details. Reload both pages and retry.' });
    port.close();
    return;
  }
  let controller;
  let waiting;
  let bytes = 0;
  let taken = false;
  let ended = false;
  let timer;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  event.waitUntil(done);
  const finish = message => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    transfers.delete(data.token);
    port.postMessage(message);
    port.close();
    waiting?.();
    settle();
  };
  const fail = message => {
    if (ended) return;
    controller?.error(new Error(message));
    finish({ type: 'error', message });
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail('The receiving page stopped responding.'), 180_000);
  };
  const entry = {
    clientId: client.id, touch, done,
    response() {
      if (taken) return new Response('This download has already started.', { status: 410 });
      taken = true;
      // TextEncoder replaces lone surrogates. Strip paths/control characters and
      // encode the filename solely in the header, never in a request URL.
      const name = new TextDecoder().decode(new TextEncoder().encode(data.name)).replace(/[\\/\u0000-\u001f\u007f]/g, '_') || 'download';
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
      const stream = new ReadableStream({
        start(value) { controller = value; },
        pull() {
          if (ended) return;
          return new Promise(resolve => { waiting = resolve; port.postMessage({ type: 'pull' }); });
        },
        cancel() { finish({ type: 'error', message: 'The download was cancelled by your browser.' }); },
      }, { highWaterMark: 1 });
      port.postMessage({ type: 'started' });
      return new Response(stream, { headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
        'Content-Length': String(data.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      } });
    },
  };
  port.onmessage = event => {
    if (ended) return;
    touch();
    const message = event.data;
    if (message?.type === 'abort') { fail('The transfer was interrupted.'); return; }
    if (message?.type === 'chunk') {
      const chunk = message.chunk;
      if (!waiting || !(chunk instanceof Uint8Array) || !chunk.length || chunk.length > 64 * 1024 || bytes + chunk.length > data.size) {
        fail('Invalid download chunk.'); return;
      }
      bytes += chunk.length;
      controller.enqueue(chunk);
      const pulled = waiting;
      waiting = undefined;
      port.postMessage({ type: 'written' });
      pulled();
    } else if (message?.type === 'end') {
      if (!taken || bytes !== data.size) { fail('The received file is incomplete.'); return; }
      controller.close();
      finish({ type: 'closed' });
    } else {
      fail('Invalid download message.');
    }
  };
  port.onmessageerror = () => fail('The download connection failed.');
  transfers.set(data.token, entry);
  touch();
  port.postMessage({ type: 'ready' });
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  const token = url.pathname.slice(prefix.length);
  const entry = transfers.get(token);
  if (event.request.method !== 'GET' || !entry) {
    event.respondWith(new Response('This download is no longer available. Return to the transfer page.', { status: 410 }));
    return;
  }
  event.waitUntil(entry.done);
  event.respondWith(entry.response());
});
