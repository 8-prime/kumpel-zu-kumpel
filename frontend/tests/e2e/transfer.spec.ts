import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function createLink(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create share link' }).click();
  await expect(page.getByRole('status')).toHaveText('Waiting for your peer');
  return page.getByLabel('Your private share link').inputValue();
}

test('two peers transfer exact bytes after closing signaling; the key stays out of network requests', async ({ page, browser }) => {
  const peerContext = await browser.newContext();
  const receiver = await peerContext.newPage();
  const errors: string[] = [];
  const urls: string[] = [];
  const frames: string[] = [];
  let closedSockets = 0;
  for (const tab of [page, receiver]) {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('request', request => urls.push(request.url()));
    tab.on('websocket', ws => {
      if (!ws.url().includes('/ws/')) return; // Exclude Vite's development socket.
      urls.push(ws.url());
      ws.on('framesent', event => frames.push(event.payload.toString()));
      ws.on('close', () => closedSockets++);
    });
  }
  const link = await createLink(page);
  const key = new URLSearchParams(new URL(link).hash.slice(1)).get('key')!;
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toHaveCount(0);
  await receiver.goto(link);
  await expect(page.getByRole('status')).toHaveText('Connected directly', { timeout: 60_000 });
  await expect(receiver.getByRole('status')).toHaveText('Connected directly');
  await expect.poll(() => closedSockets).toBe(2);

  const payloads = [
    { name: 'hello-ä.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello, Kumpel! 🦊\n') },
    { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    { name: 'binary.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251)) },
  ];
  const frameCount = frames.length;
  await page.getByLabel('Choose files to send').setInputFiles(payloads);
  await expect(page.getByText('3 of 3 complete')).toBeVisible({ timeout: 45_000 });
  for (const payload of payloads) {
    const downloadEvent = receiver.waitForEvent('download');
    await receiver.getByRole('link', { name: `Save ${payload.name}`, exact: true }).click();
    const download = await downloadEvent;
    const actual = await readFile((await download.path())!);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(payload.buffer).digest('hex'));
  }
  // Adding another file reuses the live P2P connection without reopening signaling.
  await page.getByLabel('Choose files to send').setInputFiles({ name: 'another.txt', mimeType: 'text/plain', buffer: Buffer.from('another file') });
  await expect(page.getByText('4 of 4 complete')).toBeVisible();
  expect(frames.length).toBe(frameCount);
  expect(urls.every(url => !url.includes(key))).toBe(true);
  expect(frames.every(frame => !frame.includes(key) && !frame.includes('hello-ä.txt') && !frame.includes('v=0'))).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/sender-desktop.png', fullPage: true });
  await receiver.screenshot({ path: 'test-results/receiver-desktop.png', fullPage: true });
  await receiver.close();
  await expect(page.getByRole('alert')).toContainText('disconnected');
  await peerContext.close();
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
