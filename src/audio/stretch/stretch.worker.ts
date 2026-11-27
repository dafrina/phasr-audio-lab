/** Time-stretches audio off the main thread (stretch/vocoder.ts): one job at a time. */
import { timeStretch } from './vocoder';

interface Job {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  factor: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    const out = timeStretch(j.channels, j.sampleRate, j.factor);
    self.postMessage({ id: j.id, channels: out }, { transfer: out.map((c) => c.buffer) });
  } catch (err) {
    self.postMessage({ id: j.id, error: err instanceof Error ? err.message : String(err) });
  }
};
