/**
 * Multi-resolution waveform peak cache. Level 0 stores min/max for every
 * BASE_BUCKET frames (all channels combined); each further level halves the
 * resolution. Drawing picks the coarsest level that still has at least one
 * bucket per pixel, so redraws never touch raw samples.
 */
export const BASE_BUCKET = 128;

export interface PeakLevel {
  bucket: number;
  min: Float32Array;
  max: Float32Array;
}

export interface PeakCache {
  frames: number;
  sampleRate: number;
  levels: PeakLevel[];
}

export function computePeaks(channels: Float32Array[], sampleRate: number): PeakCache {
  const frames = channels[0]?.length ?? 0;
  const n0 = Math.max(1, Math.ceil(frames / BASE_BUCKET));
  const min = new Float32Array(n0);
  const max = new Float32Array(n0);
  for (let b = 0; b < n0; b++) {
    let lo = 1;
    let hi = -1;
    const s = b * BASE_BUCKET;
    const e = Math.min(frames, s + BASE_BUCKET);
    for (const ch of channels) {
      for (let i = s; i < e; i++) {
        const v = ch[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo > hi) {
      lo = 0;
      hi = 0;
    }
    min[b] = lo;
    max[b] = hi;
  }
  const levels: PeakLevel[] = [{ bucket: BASE_BUCKET, min, max }];
  let prev = levels[0] as PeakLevel;
  while (prev.min.length > 64) {
    const n = Math.ceil(prev.min.length / 2);
    const lmin = new Float32Array(n);
    const lmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = 2 * i;
      const b = Math.min(prev.min.length - 1, a + 1);
      lmin[i] = Math.min(prev.min[a] as number, prev.min[b] as number);
      lmax[i] = Math.max(prev.max[a] as number, prev.max[b] as number);
    }
    const lvl = { bucket: prev.bucket * 2, min: lmin, max: lmax };
    levels.push(lvl);
    prev = lvl;
  }
  return { frames, sampleRate, levels };
}

/** Choose the best level for a given number of source frames per pixel. */
export function pickLevel(cache: PeakCache, framesPerPixel: number): PeakLevel {
  let best = cache.levels[0] as PeakLevel;
  for (const l of cache.levels) {
    if (l.bucket <= framesPerPixel) best = l;
  }
  return best;
}

/**
 * Min/max of the source range [startFrame, endFrame) using the cache.
 * Returns [min, max].
 */
export function peakRange(level: PeakLevel, startFrame: number, endFrame: number, out: [number, number]): [number, number] {
  const a = Math.max(0, Math.floor(startFrame / level.bucket));
  const b = Math.min(level.min.length, Math.max(a + 1, Math.ceil(endFrame / level.bucket)));
  let lo = 0;
  let hi = 0;
  for (let i = a; i < b; i++) {
    const mn = level.min[i] as number;
    const mx = level.max[i] as number;
    if (mn < lo) lo = mn;
    if (mx > hi) hi = mx;
  }
  out[0] = lo;
  out[1] = hi;
  return out;
}
