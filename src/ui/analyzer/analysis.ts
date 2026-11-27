/**
 * The analysers' arithmetic, kept pure (and allocation-free per frame) so it
 * is cheap on the main thread and testable in Node: log-frequency axes over
 * FFT bins, the oscilloscope's trigger and the spectrogram's colours.
 */

export const F_MIN = 20;
export const F_MAX = 20000;

/** frequency → 0..1 along a log axis from F_MIN to F_MAX */
export function freqToUnit(f: number): number {
  return Math.log(Math.max(F_MIN, f) / F_MIN) / Math.log(F_MAX / F_MIN);
}

export function unitToFreq(u: number): number {
  return F_MIN * Math.pow(F_MAX / F_MIN, u);
}

/**
 * For `cells` equal steps along the log axis: the first FFT bin of each and,
 * at [cells], the end. A cell narrower than a bin (the bass) gets the one bin
 * it sits in, so every cell has at least one.
 */
export function logBinRanges(cells: number, bins: number, sampleRate: number): Int32Array {
  const out = new Int32Array(cells + 1);
  const hzPerBin = sampleRate / (2 * bins);
  // (frequency rises with c, so the starts never go down; cellPeaks reads at least one bin per cell)
  for (let c = 0; c <= cells; c++) out[c] = Math.min(bins - 1, Math.max(0, Math.round(unitToFreq(c / cells) / hzPerBin)));
  return out;
}

/** the largest value of `data` in each cell (`ranges` from logBinRanges), into `out` */
export function cellPeaks(data: ArrayLike<number>, ranges: Int32Array, out: Float32Array | Uint8Array): void {
  const cells = ranges.length - 1;
  for (let c = 0; c < cells; c++) {
    const a = ranges[c] as number;
    const b = Math.max(a + 1, ranges[c + 1] as number);
    let m = -Infinity;
    for (let i = a; i < b; i++) {
      const v = data[i] as number;
      if (v > m) m = v;
    }
    out[c] = m;
  }
}

/**
 * Oscilloscope trigger: the first rising zero crossing in [from, to) that comes
 * after the signal was below −hysteresis (so noise wiggling around zero does
 * not trigger). The crossing is where the waveform starts on screen, so a
 * periodic signal stands still from frame to frame. −1 if there is none.
 */
export function findTrigger(buf: ArrayLike<number>, from: number, to: number, hysteresis: number): number {
  let armed = false;
  const end = Math.min(to, buf.length);
  for (let i = Math.max(1, from); i < end; i++) {
    const x = buf[i] as number;
    if (x < -hysteresis) armed = true;
    else if (armed && x >= 0 && (buf[i - 1] as number) < 0) return i;
  }
  return -1;
}

/** the signal's peak, for the trigger's hysteresis and for skipping silent frames */
export function peakOf(buf: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] as number);
    if (v > p) p = v;
  }
  return p;
}

/**
 * 256 spectrogram colours (dark → violet → orange → yellow-white), as
 * little-endian RGBA words for an ImageData's Uint32 view.
 */
export function spectrogramPalette(): Uint32Array {
  const stops: [number, number, number, number][] = [
    [0, 8, 8, 14],
    [0.25, 46, 16, 92],
    [0.5, 160, 36, 120],
    [0.75, 245, 120, 40],
    [1, 252, 248, 200],
  ];
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > (stops[k + 1] as number[])[0]!) k++;
    const [t0, r0, g0, b0] = stops[k] as [number, number, number, number];
    const [t1, r1, g1, b1] = stops[k + 1] as [number, number, number, number];
    const u = (t - t0) / (t1 - t0);
    const r = Math.round(r0 + (r1 - r0) * u);
    const g = Math.round(g0 + (g1 - g0) * u);
    const b = Math.round(b0 + (b1 - b0) * u);
    out[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return out;
}
