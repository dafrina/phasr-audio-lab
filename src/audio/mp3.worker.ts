/** Encodes MP3 off the main thread (LAME is CPU-heavy: seconds for a full song). */
import { encodeMp3, type Mp3Bitrate } from './mp3';

interface Job {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  kbps: Mp3Bitrate;
  title: string;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    let last = 0;
    const bytes = encodeMp3(j.left, j.right, {
      sampleRate: j.sampleRate,
      kbps: j.kbps,
      title: j.title,
      onProgress: (f) => {
        if (f - last >= 0.02 || f >= 1) {
          last = f;
          self.postMessage({ type: 'progress', value: f });
        }
      },
    });
    self.postMessage({ type: 'done', bytes }, { transfer: [bytes.buffer] });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
