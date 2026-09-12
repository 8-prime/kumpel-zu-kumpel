// Validate stock Firefox without browser.setDownloadBehavior. Firefox 150/151's
// BiDi implementation cancels/re-fetches downloads to change their destination
// (Mozilla bug 2017252, fixed in 152), which destroys one-use worker responses.
// Use native download preferences in a disposable profile instead.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const downloadOnly = process.env.DOWNLOAD_ONLY === '1';
const cache = join(root, '.cache');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'firefox-stream-'));
const profile = join(temporary, 'profile'), downloads = join(temporary, 'downloads');
await mkdir(profile); await mkdir(downloads);
const preferences = {
  'browser.download.folderList': 2,
  'browser.download.dir': downloads,
  'browser.download.useDownloadDir': true,
  'browser.download.always_ask_before_handling_new_types': false,
  'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream',
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'app.update.disabledForTesting': true,
};
await writeFile(join(profile, 'user.js'), Object.entries(preferences).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));

const children = [];
let socket;
let browser;
let senderBrowser;
let browserLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Timed out waiting for Firefox.');
}
async function reachable(url) { try { return (await fetch(url)).status < 500; } catch { return false; } }
function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.on('error', error => console.error(error));
  return child;
}
const requests = new Map();
let sequence = 0;
function call(method, params = {}, timeout = 60_000) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, timeout);
    requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(context, expression, timeout) {
  if (typeof context !== 'string') {
    const result = await context.evaluate(`(async () => JSON.stringify(await (${expression})))()`);
    return result === undefined ? undefined : JSON.parse(result);
  }
  const result = await call('script.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context }, awaitPromise: true }, timeout);
  if (result.type !== 'success') throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value === undefined ? undefined : JSON.parse(result.result.value);
}
async function tab(url = 'http://127.0.0.1:5173/') {
  const { context } = await call('browsingContext.create', { type: 'tab' });
  await call('browsingContext.navigate', { context, url, wait: 'complete' });
  return context;
}
async function click(context, label) {
  const point = await until(() => evaluate(context, `(() => {
    const button = [...document.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') || button.textContent) === ${JSON.stringify(label)});
    if (!button) return null;
    button.scrollIntoView();
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`));
  await call('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', x: point.x, y: point.y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
  ] }] });
}
async function downloaded(name, size, timeout = 60_000) {
  const path = join(downloads, name);
  await until(async () => {
    try { return (await stat(path)).size === size && !(await readdir(downloads)).some(file => file.endsWith('.part')); } catch { return false; }
  }, timeout);
  return path;
}

try {
  if (!await reachable('http://127.0.0.1:3000/')) {
    start('cargo', ['run', '--offline', '-p', 'server'], resolve(root, '../backend'));
    await until(() => reachable('http://127.0.0.1:3000/'), 120_000);
  }
  if (!await reachable('http://127.0.0.1:5173/')) {
    start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], root);
    await until(() => reachable('http://127.0.0.1:5173/'));
  }
  browser = start(process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe', ['--headless', '--no-remote', '--remote-debugging-port=0', '--profile', profile], root);
  browser.stderr.on('data', data => { browserLog = (browserLog + data).slice(-16_000); });
  const endpoint = await until(() => browserLog.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/)?.[1]);
  socket = new WebSocket(`${endpoint}/session`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'log.entryAdded' && data.params.level === 'error') console.error('Browser error:', data.params.text);
    if (data.method === 'browsingContext.userPromptOpened') console.error('Browser prompt:', data.params.type, data.params.message);
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id);
    if (data.type === 'error') request.reject(new Error(`${data.error}: ${data.message}`));
    else request.resolve(data.result);
  });
  socket.addEventListener('close', event => {
    for (const request of requests.values()) request.reject(new Error(`Firefox automation disconnected: ${event.code} ${event.reason}`));
    requests.clear();
  });
  const { capabilities } = await call('session.new', { capabilities: {} });
  await call('session.subscribe', { events: ['log.entryAdded', 'browsingContext.userPromptOpened'] });
  console.log(`Testing native Firefox ${capabilities.browserVersion}`);
  let sender;
  if (!downloadOnly && process.env.SENDER_CHANNEL) {
    const { chromium } = await import('@playwright/test');
    senderBrowser = await chromium.launch({ channel: process.env.SENDER_CHANNEL });
    sender = await senderBrowser.newPage();
    await sender.goto('http://127.0.0.1:5173/');
    console.log(`Sender browser: ${process.env.SENDER_CHANNEL}`);
  } else sender = await tab();
  const link = downloadOnly ? null : await evaluate(sender, `(async () => {
    const { createSession, sessionUrl } = await import('/src/session.ts');
    const { PeerSession } = await import('/src/peer.ts');
    const session = createSession();
    window.testState = { status: '', error: '', file: null };
    window.peer = new PeerSession(session, {
      status(status, error) { testState.status = status; testState.error = error || ''; },
      file(file) { testState.file = file; }
    });
    void peer.connect();
    return sessionUrl(location.href, session, 'receiver');
  })()`);
  const receiver = downloadOnly ? sender : await tab(link);
  if (!downloadOnly) await until(() => evaluate(sender, `testState.status === 'connected'`));
  async function send(name, size) {
    if (downloadOnly) {
      await evaluate(sender, `(() => {
        window.testState = { error: '', file: { status: 'receiving', bytes: 0 } };
        void (async () => {
          const { createDownload } = await import('/src/download.ts');
          const sink = await createDownload(${JSON.stringify(name)}, ${size}, error => { testState.error = error.message; });
          await sink.started;
          for (let offset = 0; offset < ${size}; offset += 16320) {
            await sink.write(new Uint8Array(Math.min(16320, ${size} - offset)).fill(90));
            testState.file.bytes = Math.min(offset + 16320, ${size});
          }
          await sink.close(); testState.file.status = 'complete';
        })().catch(error => { testState.error = error.message; });
      })()`);
      return;
    }
    await evaluate(sender, `(() => {
      testState.file = null; testState.error = '';
      void peer.sendFiles([{ name: ${JSON.stringify(name)}, size: ${size}, slice(start, end) {
        return new Blob([new Uint8Array(Math.min(end, ${size}) - start).fill(90)]);
      } }]).catch(error => { testState.error = error.message; });
    })()`);
    await click(receiver, `Accept download ${name}`);
  }
  for (const [name, size] of [['unicode-ä.bin', 37], ['empty.bin', 0]]) {
    await send(name, size);
    const path = await downloaded(name, size);
    assert.deepEqual(await readFile(path), Buffer.alloc(size, 90));
    await until(() => evaluate(sender, `testState.file?.status === 'complete'`));
    console.log(`PASS native download: ${name}, ${size} bytes`);
  }
  const size = Number(process.env.LARGE_TRANSFER_MIB || 320) * 1024 ** 2;
  const started = Date.now();
  await send('large.bin', size);
  let lastLog = 0;
  let peakPrivateMiB = 0;
  let lastBytes = 0, lastProgress = Date.now();
  let diagnosed = false;
  await until(async () => {
    // Observe the actual native download on disk. Constant script.evaluate
    // polling adds debugger work to the same thread doing the file encryption.
    const names = (await readdir(downloads)).filter(name => name === 'large.bin' || name.endsWith('.part'));
    const bytes = Math.max(0, ...(await Promise.all(names.map(async name => {
      try { return (await stat(join(downloads, name))).size; } catch { return 0; }
    }))));
    if (bytes > lastBytes) { lastBytes = bytes; lastProgress = Date.now(); }
    if (!diagnosed && Date.now() - lastProgress > 15_000) {
      diagnosed = true;
      for (const [role, context] of [['sender', sender], ['receiver', receiver]]) {
        try {
          const state = await evaluate(context, `({ state: window.testState, text: document.body.innerText,
            transport: window.peer?.transfer && { sequence: peer.transfer.sendSequence, received: peer.transfer.receiveSequence,
              queuedBytes: peer.transfer.queuedBytes, acknowledgedBytes: peer.transfer.acknowledgedBytes,
              bufferedAmount: peer.transfer.channel.bufferedAmount, channel: peer.transfer.channel.readyState } })`, 3000);
          console.error('Stall diagnostics:', role, JSON.stringify(state));
        } catch (error) { console.error('Stall diagnostics:', role, error.message); }
      }
    }
    assert.ok(Date.now() - lastProgress < 180_000, `Native download stalled at ${lastBytes} bytes`);
    if (Date.now() - lastLog > 30_000) {
      let memory = '';
      if (process.platform === 'win32') {
        // Firefox's Windows launcher adds a level above the main process.
        // Include all descendants, not just the launcher's direct children.
        const query = `$tree = Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'"; $ids = [System.Collections.Generic.HashSet[int]]::new(); $null = $ids.Add(${browser.pid}); do { $changed = $false; foreach ($item in $tree) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } } } while ($changed); (Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum`;
        const bytes = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', query], { windowsHide: true, encoding: 'utf8' }).trim());
        const privateMiB = Math.round(bytes / 1024 ** 2);
        peakPrivateMiB = Math.max(peakPrivateMiB, privateMiB);
        memory = `; Firefox private memory ${privateMiB} MiB`;
      }
      console.log(`Downloaded: ${Math.round(bytes / 1024 ** 2)} / ${size / 1024 ** 2} MiB${memory}`);
      lastLog = Date.now();
    }
    return bytes === size && !names.some(name => name.endsWith('.part'));
  }, Math.max(180_000, size / 1024 ** 2 * 150));
  await until(async () => {
    const state = await evaluate(sender, 'testState');
    assert.equal(state.error, '');
    return state.file?.status === 'complete';
  });
  const path = await downloaded('large.bin', size);
  const hash = createHash('sha256'), expected = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const block = Buffer.alloc(1024 ** 2, 90);
  for (let offset = 0; offset < size; offset += block.length) expected.update(block.subarray(0, Math.min(block.length, size - offset)));
  assert.equal(hash.digest('hex'), expected.digest('hex'));
  console.log(`PASS ${downloadOnly ? 'local streaming' : 'encrypted P2P'} download: ${size} bytes, SHA-256 verified, ${((Date.now() - started) / 1000).toFixed(1)} seconds`);
  if (peakPrivateMiB) console.log(`Peak sampled Firefox private memory: ${peakPrivateMiB} MiB (all test browser processes)`);

  const slow = await tab();
  await evaluate(slow, `(() => {
    window.slowDone = false; window.slowError = '';
    void (async () => {
      const { createDownload } = await import('/src/download.ts');
      const sink = await createDownload('slow.bin', 2, error => { slowError = error.message; });
      await sink.started; await sink.write(new Uint8Array([7]));
      await new Promise(resolve => setTimeout(resolve, 45_000));
      await sink.write(new Uint8Array([9])); await sink.close(); slowDone = true;
    })().catch(error => { slowError = error.message; });
  })()`);
  await until(async () => { assert.equal(await evaluate(slow, 'slowError'), ''); return evaluate(slow, 'slowDone'); }, 75_000);
  assert.deepEqual(await readFile(await downloaded('slow.bin', 2)), Buffer.from([7, 9]));
  console.log('PASS native download survives a 45-second pause');
  await call('browser.close');
} catch (error) {
  const files = await Promise.all((await readdir(downloads)).map(async name => ({ name, bytes: (await stat(join(downloads, name))).size })));
  console.error('Firefox failure diagnostics:', JSON.stringify({ files, browserLog }));
  throw error;
} finally {
  await senderBrowser?.close();
  socket?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* already exited */ }
      } else child.kill();
    }
  }
  // Only remove this harness's freshly created directory inside the project.
  if (!temporary.startsWith(cache + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unexpected temporary path.');
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
