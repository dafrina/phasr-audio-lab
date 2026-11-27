/**
 * Main-thread wrapper: run the MP3 encoder in a worker (falls back to this
 * thread if workers fail; only then is LAME loaded here, as its own chunk).
 */
import { inspectMp3, type Mp3Bitrate, type Mp3Info } from './mp3Format';
import Mp3Worker from './mp3.worker.ts?worker';

export async function encodeMp3Async(left: Float32Array, right: Float32Array, sampleRate: number, kbps: Mp3Bitrate, title: string, onProgress?: (f: number) => void): Promise<Uint8Array> {
  let worker: Worker | null = null;
  try {
    worker = new Mp3Worker();
  } catch {
    worker = null;
  }
  if (!worker) {
    const { encodeMp3 } = await import('./mp3');
    return encodeMp3(left, right, { sampleRate, kbps, title, onProgress });
  }
  const w = worker;
  return new Promise<Uint8Array>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ type: 'progress'; value: number } | { type: 'done'; bytes: Uint8Array } | { type: 'error'; message: string }>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.value);
      else {
        w.terminate();
        if (m.type === 'done') resolve(m.bytes);
        else reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'MP3 encoder worker failed'));
    };
    // copies: the rendered buffers stay valid for the caller
    const l = left.slice();
    const r = right.slice();
    w.postMessage({ left: l, right: r, sampleRate, kbps, title }, [l.buffer, r.buffer]);
  });
}

export interface Mp3Verification {
  info: Mp3Info;
  /** the browser could decode it back to audio of the right length */
  decodes: boolean | null;
  ok: boolean;
}

/** Check frame structure, then decode the file back (when the browser can) and compare duration. */
export async function verifyMp3(bytes: Uint8Array, expectedSec: number, sampleRate: number): Promise<Mp3Verification> {
  const info = inspectMp3(bytes);
  // LAME adds encoder delay + padding: up to ~2 frames of extra length
  const lengthOk = info.durationSec >= expectedSec - 0.001 && info.durationSec <= expectedSec + (3 * 1152) / sampleRate;
  let decodes: boolean | null = null;
  try {
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    decodes = Math.abs(buf.duration - expectedSec) < 0.1 && buf.numberOfChannels === 2;
  } catch {
    decodes = false;
  }
  return { info, decodes, ok: info.wellFormed && info.hasId3 && info.channels === 2 && info.sampleRate === sampleRate && lengthOk && decodes !== false };
}
