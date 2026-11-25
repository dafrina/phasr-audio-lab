/**
 * Pure helpers for audio recording: assembling captured chunks, live peak
 * accumulation for the growing waveform, and latency-compensated clip placement.
 */
import { secondsToTicks } from '../core/time';

export interface CapturedChunk {
  l: Float32Array;
  r: Float32Array;
  /** valid frames in this chunk (the last one may be partial) */
  frames: number;
}

/** Concatenate captured chunks into contiguous channel arrays. */
export function assembleChunks(chunks: CapturedChunk[]): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const total = chunks.reduce((a, c) => a + c.frames, 0);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    l.set(c.l.subarray(0, c.frames), off);
    r.set(c.r.subarray(0, c.frames), off);
    off += c.frames;
  }
  return [l, r];
}

export const LIVE_PEAK_BUCKET = 512;

/** Growing min/max peak list for drawing the waveform while recording. */
export class LivePeaks {
  min: number[] = [];
  max: number[] = [];
  frames = 0;
  private curMin = 1;
  private curMax = -1;
  private inBucket = 0;

  push(l: Float32Array, r: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const lo = a < b ? a : b;
      const hi = a > b ? a : b;
      if (lo < this.curMin) this.curMin = lo;
      if (hi > this.curMax) this.curMax = hi;
      if (++this.inBucket === LIVE_PEAK_BUCKET) {
        this.min.push(this.curMin);
        this.max.push(this.curMax);
        this.curMin = 1;
        this.curMax = -1;
        this.inBucket = 0;
      }
    }
    this.frames += frames;
  }
}

export interface RecordedClipPlacement {
  /** clip start on the timeline (ticks) — where recording started */
  start: number;
  /** clip length in ticks */
  length: number;
  /** seconds trimmed from the start of the recording (latency compensation) */
  sourceOffset: number;
}

/**
 * Where a recording lands. Input + output latency mean the captured audio is
 * late relative to what the performer heard, so the first `latencySec` of the
 * capture is skipped via sourceOffset (non-destructively — the samples remain
 * in the asset) and the clip stays aligned to the recording start position.
 */
export function placeRecordedClip(startTick: number, durationSec: number, latencySec: number, bpm: number): RecordedClipPlacement {
  const offset = Math.min(Math.max(0, latencySec), Math.max(0, durationSec - 0.01));
  const usable = Math.max(0, durationSec - offset);
  return {
    start: Math.max(0, Math.round(startTick)),
    length: Math.max(1, Math.floor(secondsToTicks(usable, bpm))),
    sourceOffset: offset,
  };
}

/** Round-trip latency estimate in seconds: output path + input path + user offset. */
export function estimateLatency(parts: { baseLatency?: number; outputLatency?: number; inputLatency?: number; manualOffsetMs?: number }): number {
  const sum = (parts.baseLatency ?? 0) + (parts.outputLatency ?? 0) + (parts.inputLatency ?? 0) + (parts.manualOffsetMs ?? 0) / 1000;
  return Math.max(0, Number.isFinite(sum) ? sum : 0);
}
