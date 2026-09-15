// Same-machine throughput check using real WebRTC, encryption, file reads, and
// the browser download manager. Signaling is exchanged locally by the harness.
import { chromium, firefox } from '@playwright/test';
import { createServer } from 'vite';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mib = Number(process.env.BENCHMARK_MIB || 128);
const rounds = Number(process.env.BENCHMARK_ROUNDS || 3);
const transferModule = process.env.BENCHMARK_TRANSFER_MODULE || '/src/transfer.ts';
if (!Number.isSafeInteger(mib) || mib < 1 || !Number.isSafeInteger(rounds) || rounds < 1) {
  throw new Error('BENCHMARK_MIB and BENCHMARK_ROUNDS must be positive integers.');
}
const size = mib * 1024 ** 2;
await mkdir(join(root, '.cache'), { recursive: true });
const temporary = await mkdtemp(join(root, '.cache', 'throughput-'));
const source = join(temporary, 'throughput.bin');
let server, senderBrowser, receiverBrowser;
async function launch(channel) {
  return (channel?.startsWith('moz-firefox') || channel === 'firefox' ? firefox : chromium)
    .launch({ channel: channel === 'firefox' ? undefined : channel });
}
try {
  const block = Buffer.from(Array.from({ length: 1024 ** 2 }, (_, i) => i % 251));
  const expected = createHash('sha256');
  const file = await open(source, 'w');
  try {
    for (let i = 0; i < mib; i++) {
      await file.writeFile(block);
      expected.update(block);
    }
  } finally { await file.close(); }
  const digest = expected.digest('hex');
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5183, strictPort: true } });
  await server.listen();
  senderBrowser = await launch(process.env.SENDER_CHANNEL || process.env.PLAYWRIGHT_CHANNEL);
  receiverBrowser = await launch(process.env.RECEIVER_CHANNEL || process.env.PLAYWRIGHT_CHANNEL);
  console.log(`Sender: ${senderBrowser.version()}; receiver: ${receiverBrowser.version()}; module: ${transferModule}; ${mib} MiB per round; loopback, real file and download`);
  for (let round = 1; round <= rounds; round++) {
    const senderContext = await senderBrowser.newContext();
    const receiverContext = await receiverBrowser.newContext();
    try {
      const sender = await senderContext.newPage(), receiver = await receiverContext.newPage();
      const secret = randomBytes(32).toString('base64url');
      for (const [page, role] of [[sender, 'sender'], [receiver, 'receiver']]) {
        await page.goto('http://127.0.0.1:5183/');
        await page.evaluate(async ({ role, secret, transferModule }) => {
          const { FileTransfer } = await import(transferModule);
          const { importSessionKey } = await import('/src/crypto.ts');
          const { createDownload } = await import('/src/download.ts');
          const key = await importSessionKey(secret);
          const state = window.benchmark = { ready: false, error: '', started: 0, elapsed: 0, bytes: 0, reads: 0, timings: {} };
          const timed = (name, fn) => async (...args) => {
            const start = performance.now();
            try { return await fn(...args); }
            finally { state.timings[name] = (state.timings[name] || 0) + performance.now() - start; }
          };
          for (const name of ['encrypt', 'decrypt']) crypto.subtle[name] = timed(name, crypto.subtle[name].bind(crypto.subtle));
          const arrayBuffer = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = function () { return timed('read', () => arrayBuffer.call(this))(); };
          const pc = state.pc = new RTCPeerConnection({ iceServers: [] });
          const attach = channel => {
            let opened = false;
            const start = () => {
              if (opened) return;
              opened = true;
              state.transfer = new FileTransfer(channel, key, 'throughput-test', role, {
                ready() { state.ready = true; },
                error(error) { state.error = error.message; },
                file(file) {
                  if (file.status === 'sending' || file.status === 'receiving') {
                    if (!state.started) state.started = performance.now();
                    state.bytes = file.bytes;
                  }
                  if (file.status === 'complete') state.elapsed = performance.now() - state.started;
                  if (role === 'receiver' && file.status === 'offered') void state.transfer.acceptFile(file.id);
                },
              }, async (...args) => {
                const sink = await createDownload(...args);
                sink.write = timed('write', sink.write.bind(sink));
                return sink;
              });
              for (const name of ['waitForCredit', 'waitForCapacity']) {
                state.transfer[name] = timed(name, state.transfer[name].bind(state.transfer));
              }
            };
            channel.onopen = start;
            if (channel.readyState === 'open') start();
          };
          pc.ondatachannel = event => attach(event.channel);
          if (role === 'sender') attach(pc.createDataChannel('files', { ordered: true }));
          state.description = async () => {
            await pc.setLocalDescription();
            if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
              pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') resolve();
              });
            });
            return pc.localDescription.toJSON();
          };
        }, { role, secret, transferModule });
      }
      const offer = await sender.evaluate(() => window.benchmark.description());
      await receiver.evaluate(offer => window.benchmark.pc.setRemoteDescription(offer), offer);
      const answer = await receiver.evaluate(() => window.benchmark.description());
      await sender.evaluate(answer => window.benchmark.pc.setRemoteDescription(answer), answer);
      for (const page of [sender, receiver]) await page.waitForFunction(() => window.benchmark.ready);
      await sender.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file'; input.id = 'benchmark-source'; document.body.append(input);
      });
      await sender.locator('#benchmark-source').setInputFiles(source);
      const downloading = receiver.waitForEvent('download');
      const sending = sender.evaluate(async () => {
        const file = document.querySelector('#benchmark-source').files[0];
        const slice = file.slice.bind(file);
        file.slice = (...args) => { window.benchmark.reads++; return slice(...args); };
        await window.benchmark.transfer.sendFiles([file]);
      });
      const [download] = await Promise.all([downloading, sending]);
      const path = await download.path();
      if (await download.failure()) throw new Error(await download.failure());
      if (!path) throw new Error('The browser did not save the download.');
      const actual = createHash('sha256');
      let received = 0;
      for await (const chunk of createReadStream(path)) { actual.update(chunk); received += chunk.length; }
      if (received !== size || actual.digest('hex') !== digest) throw new Error('Downloaded bytes differ from source.');
      const result = await sender.evaluate(async () => {
        const { elapsed, reads, error, pc, timings } = window.benchmark;
        const stats = await pc.getStats();
        const pair = [...stats.values()].find(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated);
        return { elapsed, reads, error, timings, rttMs: pair?.currentRoundTripTime * 1000 };
      });
      if (result.error) throw new Error(result.error);
      const receiverTimings = await receiver.evaluate(() => window.benchmark.timings);
      console.log(JSON.stringify({ round, mib, seconds: +(result.elapsed / 1000).toFixed(3), mibPerSecond: +(mib * 1000 / result.elapsed).toFixed(2), reads: result.reads, rttMs: result.rttMs, senderMs: result.timings, receiverMs: receiverTimings, sha256Verified: true }));
    } finally { await senderContext.close(); await receiverContext.close(); }
  }
} finally {
  await senderBrowser?.close();
  await receiverBrowser?.close();
  await server?.close();
  if (!resolve(temporary).startsWith(resolve(root, '.cache') + sep)) throw new Error('Unexpected temporary path.');
  await rm(temporary, { recursive: true, force: true });
}
