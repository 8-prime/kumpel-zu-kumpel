import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IncomingFileAlert } from '../../src/incoming-file-alert';

function createPage() {
  let focused = true;
  let visibility: DocumentVisibilityState = 'visible';
  const page = new EventTarget() as Document;
  Object.defineProperties(page, {
    hasFocus: { value: () => focused },
    visibilityState: { get: () => visibility },
  });
  const browserWindow = new EventTarget() as Window;
  return {
    page, browserWindow,
    blur() { focused = false; browserWindow.dispatchEvent(new Event('blur')); },
    hide() { visibility = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('alerts after three seconds while the tab remains focused, once per offer', () => {
  const { page, browserWindow } = createPage();
  const play = vi.fn();
  const alert = new IncomingFileAlert(play, page, browserWindow);
  alert.update(['first']);
  vi.advanceTimersByTime(2999);
  expect(play).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(play).toHaveBeenCalledTimes(1);
  alert.update(['first']);
  vi.advanceTimersByTime(3000);
  expect(play).toHaveBeenCalledTimes(1);
  alert.update([]);
  alert.update(['second']);
  vi.advanceTimersByTime(3000);
  expect(play).toHaveBeenCalledTimes(2);
  alert.dispose();
});

test('alerts immediately when an offer arrives in an unfocused tab or focus is lost', () => {
  const { page, browserWindow, blur, hide } = createPage();
  const play = vi.fn();
  const alert = new IncomingFileAlert(play, page, browserWindow);
  alert.update(['first']);
  blur();
  expect(play).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3000);
  expect(play).toHaveBeenCalledTimes(1);
  alert.update(['first', 'second']);
  expect(play).toHaveBeenCalledTimes(2);
  hide();
  expect(play).toHaveBeenCalledTimes(2);
  alert.update(['first', 'second', 'third']);
  expect(play).toHaveBeenCalledTimes(3);
  alert.dispose();
});

test('accepting or declining an offer cancels its pending alert', () => {
  const { page, browserWindow, blur } = createPage();
  const play = vi.fn();
  const alert = new IncomingFileAlert(play, page, browserWindow);
  alert.update(['first']);
  alert.update([]);
  blur();
  vi.advanceTimersByTime(3000);
  expect(play).not.toHaveBeenCalled();
  alert.dispose();
});
