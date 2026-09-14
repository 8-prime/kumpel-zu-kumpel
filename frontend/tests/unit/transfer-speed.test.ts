import { describe, expect, it } from 'vitest';
import { formatTransferSpeed, TransferSpeedMeter } from '../../src/transfer-speed';

describe('transfer speed', () => {
  it('uses elapsed time and byte deltas, including when timer ticks are delayed', () => {
    const meter = new TransferSpeedMeter(1024, 10_000);
    expect(meter.sample(2048, 10_500)).toBe(2048);
    expect(meter.sample(4096, 11_500)).toBe(2048);
    expect(meter.sample(8192, 13_500)).toBe(2048);
  });

  it('smooths bursts, reaches zero during a stall, and resumes', () => {
    const meter = new TransferSpeedMeter(0, 0);
    expect(meter.sample(2048, 500)).toBe(4096);
    expect(meter.sample(2048, 1000)).toBe(2048);
    expect(meter.sample(2048, 1500)).toBeCloseTo(2048 / 1.5);
    expect(meter.sample(2048, 2000)).toBe(1024);
    expect(meter.sample(2048, 2500)).toBe(0);
    expect(meter.sample(4096, 3000)).toBe(1024);
  });

  it('starts independently for each file and handles zero elapsed time or empty files', () => {
    const first = new TransferSpeedMeter(0, 0);
    expect(first.sample(1024 ** 2, 500)).toBe(2 * 1024 ** 2);
    const next = new TransferSpeedMeter(0, 500);
    expect(next.sample(0, 500)).toBe(0);
    expect(next.sample(0, 1000)).toBe(0);
    expect(next.sample(512, 1500)).toBe(512);
  });

  it.each([
    [0, '0 B/s'], [0.5, '1 B/s'], [512, '512 B/s'],
    [1024, '1.0 KiB/s'], [1536, '1.5 KiB/s'],
    [2.5 * 1024 ** 2, '2.5 MiB/s'], [1024 ** 3, '1.0 GiB/s'],
    [-1, '0 B/s'], [NaN, '0 B/s'], [Infinity, '0 B/s'],
  ])('formats %s bytes per second as %s', (speed, formatted) => {
    expect(formatTransferSpeed(speed)).toBe(formatted);
  });
});
