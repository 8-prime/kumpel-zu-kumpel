import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Exercise the real encrypted P2P transport and download manager with a virtual
// source, avoiding a second multi-GiB fixture on disk or a giant test-runner Blob.
async function virtualSender(page: Page) {
  await page.goto('/');
  return page.evaluate(async () => {
    const sessionModule = '/src/session.ts', peerModule = '/src/peer.ts';
    const { createSession, sessionUrl } = await import(sessionModule);
    const { PeerSession } = await import(peerModule);
    const session = createSession();
    const state = { peer: null as any, status: '', error: '', complete: false, bytes: 0 };
    (window as any).virtualTransfer = state;
    state.peer = new PeerSession(session, {
      status(status: string, error?: string) { state.status = status; state.error = error || ''; },
      file(file: { status: string; bytes: number }) { state.complete = file.status === 'complete'; state.bytes = file.bytes; },
    });
    void state.peer.connect();
    return sessionUrl(location.href, session, 'receiver');
  });
}

async function offer(page: Page, size: number) {
  await expect.poll(() => page.evaluate(() => (window as any).virtualTransfer.status), { timeout: 60_000 }).toBe('connected');
  await page.evaluate(size => {
    const state = (window as any).virtualTransfer;
    void state.peer.sendFiles([{
      name: 'large.bin', size,
      slice(start: number, end: number) { return new Blob([new Uint8Array(Math.min(end, size) - start).fill(0x5a)]); },
    }]).catch((error: Error) => { state.error = error.message; });
  }, size);
}

test('streams a large encrypted file through the normal browser download', async ({ page, browser }) => {
  const size = Number(process.env.LARGE_TRANSFER_MIB || 320) * 1024 ** 2;
  test.setTimeout(Math.max(180_000, size / 1024 ** 2 * 150));
  const link = await virtualSender(page);
  const receiver = await browser.newPage();
  await receiver.goto(link);
  await offer(page, size);
  const accept = receiver.getByRole('button', { name: 'Accept download large.bin', exact: true });
  await expect(accept).toBeVisible();
  expect(await page.evaluate(() => (window as any).virtualTransfer.bytes)).toBe(0);
  await receiver.screenshot({ path: `test-results/offer-${test.info().project.name}.png`, fullPage: true });
  const downloadEvent = receiver.waitForEvent('download');
  await accept.click();
  const download = await downloadEvent;
  let lastBytes = 0, lastProgress = Date.now(), observing = false;
  let timer: ReturnType<typeof setInterval>;
  const stalled = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (Date.now() - lastProgress > 180_000) reject(new Error(`Transfer stalled at ${lastBytes} bytes`));
      if (observing) return;
      observing = true;
      void page.evaluate(() => {
        const state = (window as any).virtualTransfer;
        return { bytes: state.bytes as number, error: state.error as string };
      }).then(state => {
        if (state.error) reject(new Error(state.error));
        if (state.bytes > lastBytes) { lastBytes = state.bytes; lastProgress = Date.now(); }
        console.log(`${test.info().project.name}: ${Math.round(state.bytes / 1024 ** 2)} / ${size / 1024 ** 2} MiB sent`);
      }).catch(reject).finally(() => { observing = false; });
    }, 30_000);
  });
  let path: string | null;
  try { path = await Promise.race([download.path(), stalled]); }
  finally { clearInterval(timer!); }
  expect(await download.failure()).toBeNull();
  const actual = createHash('sha256'), expected = createHash('sha256');
  const block = Buffer.alloc(1024 * 1024, 0x5a);
  let received = 0;
  for await (const chunk of createReadStream(path!)) { actual.update(chunk); received += chunk.length; }
  for (let offset = 0; offset < size; offset += block.length) expected.update(block.subarray(0, Math.min(block.length, size - offset)));
  expect(received).toBe(size);
  expect(actual.digest('hex')).toBe(expected.digest('hex'));
  await expect.poll(() => page.evaluate(() => (window as any).virtualTransfer.complete)).toBe(true);
  expect(await page.evaluate(() => (window as any).virtualTransfer.error)).toBe('');
  test.info().annotations.push({ type: 'verified-bytes', description: String(size) });
  await receiver.close();
});

test('declining a file above 10 GiB starts no download and leaves the session usable', async ({ page, browser }) => {
  const receiver = await browser.newPage();
  await receiver.setViewportSize({ width: 390, height: 844 });
  const link = await virtualSender(page);
  await receiver.goto(link);
  await offer(page, 100 * 1024 ** 3);
  let downloads = 0;
  receiver.on('download', () => downloads++);
  await expect(receiver.getByText('100.0 GiB', { exact: false })).toBeVisible();
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receiver.screenshot({ path: `test-results/offer-mobile-${test.info().project.name}.png`, fullPage: true });
  await receiver.getByRole('button', { name: 'Decline large.bin', exact: true }).click();
  await expect(receiver.getByText('100.0 GiB · Declined', { exact: true })).toBeVisible();
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => (window as any).virtualTransfer.bytes)).toBe(0);
  await expect(receiver.getByRole('status')).toHaveText('Connected directly');
  await receiver.close();
});

test('browser download cancellation stops the peer and does not report success', async ({ page, browser }) => {
  const link = await virtualSender(page);
  const receiver = await browser.newPage();
  await receiver.goto(link);
  await offer(page, 100 * 1024 ** 3);
  const downloadEvent = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Accept download large.bin', exact: true }).click();
  const download = await downloadEvent;
  await download.cancel();
  await expect(receiver.getByRole('alert')).toContainText('cancelled');
  await expect.poll(() => page.evaluate(() => (window as any).virtualTransfer.error)).not.toBe('');
  expect(await page.evaluate(() => (window as any).virtualTransfer.complete)).toBe(false);
  await receiver.close();
});

test('the download stream survives a 45-second pause in incoming data', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const downloadEvent = page.waitForEvent('download');
  const writing = page.evaluate(async () => {
    const module = '/src/download.ts';
    const { createDownload } = await import(module);
    const sink = await createDownload('slow.bin', 2, (error: Error) => { throw error; });
    await sink.started;
    await sink.write(new Uint8Array([7]));
    await new Promise(resolve => setTimeout(resolve, 45_000));
    await sink.write(new Uint8Array([9]));
    await sink.close();
  });
  const download = await downloadEvent;
  await writing;
  expect(await download.failure()).toBeNull();
  const parts: Buffer[] = [];
  for await (const chunk of createReadStream((await download.path())!)) parts.push(chunk);
  expect(Buffer.concat(parts)).toEqual(Buffer.from([7, 9]));
});
