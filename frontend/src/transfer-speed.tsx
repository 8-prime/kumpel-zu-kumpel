import { useEffect, useRef, useState } from 'react';

const SAMPLE_INTERVAL_MS = 500;
const WINDOW_MS = 2000;
type Sample = { bytes: number; time: number };

export class TransferSpeedMeter {
  private samples: Sample[];

  constructor(bytes: number, time: number) {
    this.samples = [{ bytes, time }];
  }

  sample(bytes: number, time: number) {
    const latest = this.samples[this.samples.length - 1];
    if (time <= latest.time) return 0;
    this.samples.push({ bytes, time });
    // Keep one baseline at or just before the window, even if a background
    // tab delays the timer. Idle samples let a stalled transfer reach 0 B/s.
    while (this.samples.length > 2 && this.samples[1].time <= time - WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    return Math.max(0, (bytes - first.bytes) * 1000 / (time - first.time));
  }
}

export function formatTransferSpeed(bytesPerSecond: number) {
  const speed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s', 'PiB/s'];
  const unit = speed >= 1 ? Math.min(Math.floor(Math.log2(speed) / 10), units.length - 1) : 0;
  return `${(speed / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

// Mount only while this file is sending/receiving: each file gets its own
// baseline, and completing, failing, or ending the session clears the timer.
export function TransferSpeed({ bytes, name }: { bytes: number; name: string }) {
  const latestBytes = useRef(bytes);
  const [speed, setSpeed] = useState(0);

  useEffect(() => { latestBytes.current = bytes; }, [bytes]);
  useEffect(() => {
    const meter = new TransferSpeedMeter(latestBytes.current, performance.now());
    const timer = setInterval(() => {
      setSpeed(meter.sample(latestBytes.current, performance.now()));
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return <span className="transfer-speed" aria-label={`Transfer speed for ${name}`}>{formatTransferSpeed(speed)}</span>;
}
