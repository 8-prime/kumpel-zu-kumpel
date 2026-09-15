import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window { signalTrace: { urls: string[]; frames: string[]; closed: number } }
  interface Window { pauseFileReads: boolean }
}

async function createLink(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create share link' }).click();
  await expect(page.getByRole('status')).toHaveText('Waiting for your peer');
  return page.getByLabel('Your private share link').inputValue();
}

test('two peers transfer exact bytes after closing signaling; the key stays out of network requests', async ({ page, browser }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const peerContext = await browser.newContext({ colorScheme: 'dark' });
  const receiver = await peerContext.newPage();
  const errors: string[] = [];
  const urls: string[] = [];
  for (const tab of [page, receiver]) {
    // Instrument the browser API itself: native Firefox's BiDi connection does
    // not expose Playwright's websocket frame events.
    await tab.addInitScript(() => {
      window.signalTrace = { urls: [], frames: [], closed: 0 };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        private signaling: boolean;
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.signaling = String(url).includes('/ws/');
          if (this.signaling) {
            window.signalTrace.urls.push(String(url));
            this.addEventListener('close', () => window.signalTrace.closed++);
          }
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (this.signaling) window.signalTrace.frames.push(String(data));
          super.send(data);
        }
      };
    });
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('request', request => urls.push(request.url()));
  }
  const link = await createLink(page);
  const key = new URLSearchParams(new URL(link).hash.slice(1)).get('key')!;
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toHaveCount(0);
  await receiver.goto(link);
  await expect(page.getByRole('status')).toHaveText('Connected directly', { timeout: 60_000 });
  await expect(receiver.getByRole('status')).toHaveText('Connected directly');
  await expect.poll(async () => (await page.evaluate(() => window.signalTrace.closed)) + (await receiver.evaluate(() => window.signalTrace.closed))).toBe(2);

  // Switching themes must preserve the established transfer session.
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(receiver.locator('html')).toHaveCSS('color-scheme', 'dark');

  const payloads = [
    { name: 'hello-ä.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello, Kumpel! 🦊\n') },
    { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    { name: 'binary.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251)) },
  ];
  const traces = () => Promise.all([page, receiver].map(tab => tab.evaluate(() => window.signalTrace)));
  const frameCount = (await traces()).flatMap(trace => trace.frames).length;
  await page.getByLabel('Choose files to send').setInputFiles(payloads);
  for (const payload of payloads) {
    const downloadEvent = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Accept download ${payload.name}`, exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(payload.name);
    const actual = await readFile((await download.path())!);
    expect(actual.length, `${payload.name}: ${actual.subarray(0, 64).toString('hex')}`).toBe(payload.buffer.length);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(payload.buffer).digest('hex'));
  }
  await expect(page.getByText('3 of 3 complete')).toBeVisible({ timeout: 45_000 });
  // Adding another file reuses the live P2P connection without reopening signaling.
  await page.getByLabel('Choose files to send').setInputFiles({ name: 'another.txt', mimeType: 'text/plain', buffer: Buffer.from('another file') });
  const anotherEvent = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Accept download another.txt', exact: true }).click();
  expect(await (await anotherEvent).failure()).toBeNull();
  await expect(page.getByText('4 of 4 complete')).toBeVisible();
  const finalTraces = await traces();
  const frames = finalTraces.flatMap(trace => trace.frames);
  urls.push(...finalTraces.flatMap(trace => trace.urls));
  expect(frames.length).toBe(frameCount);
  expect(urls.every(url => !url.includes(key))).toBe(true);
  expect(frames.every(frame => !frame.includes(key) && !frame.includes('hello-ä.txt') && !frame.includes('v=0'))).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/sender-desktop.png', fullPage: true });
  await receiver.screenshot({ path: 'test-results/receiver-desktop.png', fullPage: true });
  await receiver.close();
  await expect(page.getByRole('status')).toHaveText('Connection interrupted');
  await expect(page.getByRole('alert')).toContainText(/disconnected|connection failed/);
  await peerContext.close();
});

test('both peers show current file speed, including stalls and subsequent files', async ({ page, browser }) => {
  // Slow the real source reads so both UIs can be observed during a transfer.
  await page.addInitScript(() => {
    window.pauseFileReads = false;
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      await new Promise(resolve => setTimeout(resolve, 40));
      while (window.pauseFileReads) await new Promise(resolve => setTimeout(resolve, 40));
      return read.call(this);
    };
  });
  const receiver = await browser.newPage();
  try {
    const link = await createLink(page);
    await receiver.goto(link);
    await expect(page.getByRole('status')).toHaveText('Connected directly', { timeout: 60_000 });
    await expect(receiver.getByRole('status')).toHaveText('Connected directly');
    for (const tab of [page, receiver]) await tab.setViewportSize({ width: 390, height: 844 });

    const payloads = [
      { name: 'speed.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 ** 2, 7) },
      { name: 'next.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 ** 2, 9) },
      { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    ];
    await page.getByLabel('Choose files to send').setInputFiles(payloads);
    for (const payload of payloads) {
      const speeds = [page, receiver].map(tab => tab.getByLabel(`Transfer speed for ${payload.name}`, { exact: true }));
      await expect(receiver.getByRole('button', { name: `Accept download ${payload.name}`, exact: true })).toBeVisible();
      for (const tab of [page, receiver]) await expect(tab.locator('.transfer-speed')).toHaveCount(0);

      await page.evaluate(() => { window.pauseFileReads = true; });
      const downloadEvent = receiver.waitForEvent('download');
      await receiver.getByRole('button', { name: `Accept download ${payload.name}`, exact: true }).click();
      const download = await downloadEvent;
      if (payload.buffer.length) {
        for (const speed of speeds) await expect(speed).toHaveText('0 B/s');
        await page.evaluate(() => { window.pauseFileReads = false; });
        for (const speed of speeds) {
          await expect(speed).toHaveText(/^\d+(\.\d+)? (B|KiB|MiB|GiB)\/s$/);
          await expect(speed).not.toHaveText('0 B/s');
        }
        if (payload.name === 'speed.bin') {
          await page.evaluate(() => { window.pauseFileReads = true; });
          for (const speed of speeds) await expect(speed).toHaveText('0 B/s');
          for (const tab of [page, receiver]) {
            await expect(tab.getByRole('progressbar', { name: `Progress for ${payload.name}`, exact: true })).toBeVisible();
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          }
          await page.evaluate(() => { window.pauseFileReads = false; });
          for (const speed of speeds) await expect(speed).not.toHaveText('0 B/s');
          await page.screenshot({ path: `test-results/speed-sender-${test.info().project.name}.png`, fullPage: true });
          await receiver.screenshot({ path: `test-results/speed-receiver-${test.info().project.name}.png`, fullPage: true });
        }
      }
      expect(await download.failure()).toBeNull();
      expect(await readFile((await download.path())!)).toEqual(payload.buffer);
      for (const speed of speeds) await expect(speed).toHaveCount(0);
    }
    for (const tab of [page, receiver]) await expect(tab.getByText('3 of 3 complete')).toBeVisible();
  } finally { await receiver.close(); }
});

test('a wrong fragment key cannot authenticate the peer', async ({ page, browser }) => {
  const link = new URL(await createLink(page));
  link.hash = 'key=' + 'A'.repeat(43);
  const receiver = await browser.newPage();
  await receiver.goto(link.href);
  await expect(receiver.getByRole('alert')).toContainText('authenticate', { timeout: 45_000 });
  await expect(receiver.getByRole('status')).toHaveText('Connection interrupted');
  await receiver.close();
});

test('duplicate roles cannot replace the original waiting peer', async ({ page, browser }) => {
  await createLink(page);
  const duplicate = await browser.newPage();
  await duplicate.goto(page.url());
  await expect(duplicate.getByRole('alert')).toContainText('already has a connected peer');
  await expect(page.getByRole('status')).toHaveText('Waiting for your peer');
  await duplicate.close();
});

test('mobile layout and incomplete links remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create share link' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.goto('/?session=bad&role=receiver');
  await expect(page.getByRole('alert')).toContainText('incomplete');
});
