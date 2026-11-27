/**
 * Time-stretching without changing pitch (pure, deterministic; runs in a Web
 * Worker for playback and export, and in Node tests).
 *
 * A phase vocoder (Hann window, N = 2048 at ≤ 48 kHz / 4096 above, synthesis
 * hop N/4, analysis hop N/4 ÷ factor) with the usual improvements for music:
 *  - identity phase locking (Laroche & Dolson): only spectral peaks get their
 *    phase advanced; the bins around a peak keep their phase relation to it,
 *    which removes most of the "phasiness" of a plain vocoder;
 *  - stereo kept intact: the phase rotation is computed once from the mid
 *    (L + R) spectrum and applied to both channels, so the inter-channel phase
 *    (the stereo image) is the source's;
 *  - transients kept sharp: onsets are detected on the input (a jump in
 *    high-frequency energy). The time map pins every onset to its stretched
 *    position and plays the first N/2 samples after it at the original speed
 *    (the rest of the stretch goes into the remainder of the segment); the
 *    frame at an onset restarts from the analysis phases (phase reset), and
 *    with equal hops in that stretch the following frames line up exactly, so
 *    the attack comes out as it went in. Frames before an onset only see the
 *    audio before it (no pre-echo), frames later than the copied stretch only
 *    the audio after it (no repeated attack); overlap-add is normalised per
 *    sample for those cut frames.
 * Output length = round(input length × factor); away from onsets, output
 * sample t comes from input time ≈ t / factor (onsets exactly).
 */
import { FFT } from './fft';

export interface StretchOptions {
  /** FFT / window size (power of two); default 2048 at ≤ 48 kHz, 4096 above */
  fftSize?: number;
  /** identity phase locking (default on) */
  phaseLock?: boolean;
  /** transient handling (default on) */
  transients?: boolean;
}

/** Onsets (sample indices) where the high-frequency energy jumps (≥ 9 dB within a few ms). */
export function detectOnsets(x: Float32Array, sampleRate: number): number[] {
  const hop = 128;
  const hops = Math.floor(x.length / hop);
  if (hops < 8) return [];
  const e = new Float64Array(hops);
  for (let j = 0; j < hops; j++) {
    let s = 0;
    for (let n = Math.max(1, j * hop); n < (j + 1) * hop; n++) {
      const d = (x[n] as number) - (x[n - 1] as number);
      s += d * d;
    }
    e[j] = s;
  }
  const out: number[] = [];
  const refractory = Math.round((0.05 * sampleRate) / hop);
  let last = -Infinity;
  for (let j = 4; j < hops - 1; j++) {
    const cur = (e[j] as number) + (e[j + 1] as number);
    const prev = ((e[j - 1] as number) + (e[j - 2] as number) + (e[j - 3] as number) + (e[j - 4] as number)) / 2;
    if (cur < 1e-6 || cur < 8 * prev || j - last < refractory) continue;
    // the sample where it starts: the first big step in this stretch
    const a = Math.max(1, (j - 1) * hop);
    const b = Math.min(x.length, (j + 2) * hop);
    let m = 0;
    for (let n = a; n < b; n++) m = Math.max(m, Math.abs((x[n] as number) - (x[n - 1] as number)));
    let at = j * hop;
    for (let n = a; n < b; n++) {
      if (Math.abs((x[n] as number) - (x[n - 1] as number)) > 0.25 * m) {
        at = n - 1;
        break;
      }
    }
    out.push(at);
    last = j;
  }
  return out;
}

/** Stretch 1 or 2 channels (equal length) by `factor` (output length / input length) keeping the pitch. */
export function timeStretch(channels: readonly Float32Array[], sampleRate: number, factor: number, opts: StretchOptions = {}): Float32Array[] {
  const L = channels[0];
  if (!L) return [];
  const R = channels[1] ?? null;
  const inLen = L.length;
  const outLen = Math.max(1, Math.round(inLen * factor));
  if (Math.abs(factor - 1) < 1e-9) return channels.map((c) => c.slice());
  const N = opts.fftSize ?? (sampleRate > 50000 ? 4096 : 2048);
  const half = N / 2;
  const Hs = N / 4;
  const Ha = Hs / factor;
  const lock = opts.phaseLock !== false;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);

  let onsets: number[] = [];
  if (opts.transients !== false) {
    if (R) {
      const mono = new Float32Array(inLen);
      for (let i = 0; i < inLen; i++) mono[i] = 0.5 * ((L[i] as number) + (R[i] as number));
      onsets = detectOnsets(mono, sampleRate);
    } else onsets = detectOnsets(L, sampleRate);
  }
  // the time map, output position → input position: breakpoints at every onset (pinned to
  // onset × factor) and at the end of the stretch after it that plays at the original speed
  const mapOut: number[] = [0];
  const mapIn: number[] = [0];
  const holdEnds: number[] = []; // output position where each onset's 1:1 stretch ends
  const outOn: number[] = [];
  for (let k = 0; k < onsets.length; k++) {
    const o = onsets[k] as number;
    const O = Math.round(o * factor);
    const prevO = mapOut[mapOut.length - 1] as number;
    const prevI = mapIn[mapIn.length - 1] as number;
    if (O <= prevO || o <= prevI) continue;
    const nextI = (onsets[k + 1] as number | undefined) ?? inLen;
    const nextO = Math.round(nextI * factor);
    const hold = Math.max(0, Math.floor(Math.min(half, (nextI - o) / 2, (nextO - O) / 2)));
    mapOut.push(O, O + hold);
    mapIn.push(o, o + hold);
    outOn.push(O);
    holdEnds.push(O + hold);
  }
  const onsetsUsed = mapIn.filter((_, i) => i % 2 === 1);
  mapOut.push(outLen);
  mapIn.push(inLen);
  let seg = 0;
  /** input position for an output position (monotonic calls); linear beyond the ends */
  const toIn = (t: number): number => {
    if (t <= 0) return t / factor;
    if (t >= outLen) return inLen + (t - outLen) / factor;
    while (seg < mapOut.length - 2 && t >= (mapOut[seg + 1] as number)) seg++;
    const o0 = mapOut[seg] as number;
    const o1 = mapOut[seg + 1] as number;
    const i0 = mapIn[seg] as number;
    const i1 = mapIn[seg + 1] as number;
    return o1 > o0 ? i0 + ((t - o0) * (i1 - i0)) / (o1 - o0) : i0;
  };

  const outL = new Float32Array(outLen);
  const outR = R ? new Float32Array(outLen) : null;
  const wsum = new Float64Array(outLen);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const lRe = new Float64Array(half + 1);
  const lIm = new Float64Array(half + 1);
  const rRe = new Float64Array(half + 1);
  const rIm = new Float64Array(half + 1);
  const mag = new Float64Array(half + 1);
  const ph = new Float64Array(half + 1);
  const prevPh = new Float64Array(half + 1);
  const synth = new Float64Array(half + 1);
  const owner = new Int32Array(half + 1);
  const peaks = new Int32Array(half + 1);
  const keep = new Uint8Array(N);
  const TWO_PI = 2 * Math.PI;

  const mStart = -Math.ceil(half / Hs);
  const mEnd = Math.ceil((outLen + half) / Hs);
  let prevCenter = Math.round(toIn(mStart * Hs) - Ha);
  let first = true;
  let next = 0; // the next onset whose phase reset is still to come
  for (let m = mStart; m <= mEnd; m++) {
    const cOut = m * Hs;
    const center = Math.round(toIn(cOut));
    const ha = Math.max(1, center - prevCenter);
    prevCenter = center;
    const aStart = center - half;
    // the first frame at or after an onset's stretched position starts over from its phases
    let reset = false;
    while (next < outOn.length && cOut >= (outOn[next] as number)) {
      reset = true;
      next++;
    }
    // onsets in the window: a coming one cuts the frame before it; a past one, once its
    // 1:1 stretch is over, cuts the frame after it
    let lo = aStart;
    let hi = aStart + N;
    for (let k = 0; k < onsetsUsed.length; k++) {
      const o = onsetsUsed[k] as number;
      if (o <= aStart || o >= aStart + N) continue;
      if (o > center) hi = Math.min(hi, o);
      else if (cOut >= (holdEnds[k] as number)) lo = Math.max(lo, o);
    }
    // analysis frame: L in re, R in im (one complex FFT for both)
    for (let n = 0; n < N; n++) {
      const idx = aStart + n;
      const inside = idx >= lo && idx < hi;
      keep[n] = inside ? 1 : 0;
      if (!inside || idx < 0 || idx >= inLen) {
        re[n] = 0;
        im[n] = 0;
        continue;
      }
      const w = win[n] as number;
      re[n] = (L[idx] as number) * w;
      im[n] = R ? (R[idx] as number) * w : 0;
    }
    fft.transform(re, im);
    // the two real spectra, and the mid's magnitude / phase
    for (let k = 0; k <= half; k++) {
      const nk = (N - k) % N;
      const a = ((re[k] as number) + (re[nk] as number)) / 2;
      const b = ((im[k] as number) - (im[nk] as number)) / 2;
      const c = ((re[k] as number) - (re[nk] as number)) / 2;
      const d = ((im[k] as number) + (im[nk] as number)) / 2;
      lRe[k] = a;
      lIm[k] = b;
      rRe[k] = d;
      rIm[k] = -c;
      const mr = R ? a + d : a;
      const mi = R ? b - c : b;
      mag[k] = Math.hypot(mr, mi);
      ph[k] = Math.atan2(mi, mr);
    }
    if (first || reset) {
      for (let k = 0; k <= half; k++) synth[k] = ph[k] as number;
      first = false;
    } else {
      // peaks (local maxima over ±2 bins) and the region each one owns (up to the lowest bin between peaks)
      let np = 0;
      if (lock) {
        for (let k = 2; k <= half - 2; k++) {
          const v = mag[k] as number;
          if (v > (mag[k - 1] as number) && v >= (mag[k + 1] as number) && v > (mag[k - 2] as number) && v >= (mag[k + 2] as number)) peaks[np++] = k;
        }
      }
      if (np === 0) {
        // no locking: every bin advances on its own
        for (let k = 0; k <= half; k++) {
          const omega = (TWO_PI * k) / N;
          let dp = (ph[k] as number) - (prevPh[k] as number) - omega * ha;
          dp -= TWO_PI * Math.round(dp / TWO_PI);
          synth[k] = (synth[k] as number) + (omega + dp / ha) * Hs;
        }
      } else {
        let from = 0;
        for (let j = 0; j < np; j++) {
          const p = peaks[j] as number;
          let to = half + 1;
          if (j < np - 1) {
            const q = peaks[j + 1] as number;
            let minK = p;
            for (let k = p; k <= q; k++) if ((mag[k] as number) < (mag[minK] as number)) minK = k;
            to = minK;
          }
          for (let k = from; k < to; k++) owner[k] = p;
          from = to;
        }
        for (let j = 0; j < np; j++) {
          const p = peaks[j] as number;
          const omega = (TWO_PI * p) / N;
          let dp = (ph[p] as number) - (prevPh[p] as number) - omega * ha;
          dp -= TWO_PI * Math.round(dp / TWO_PI);
          synth[p] = (synth[p] as number) + (omega + dp / ha) * Hs;
        }
        for (let k = 0; k <= half; k++) {
          const p = owner[k] as number;
          if (p !== k) synth[k] = (synth[p] as number) + (ph[k] as number) - (ph[p] as number);
        }
      }
    }
    for (let k = 0; k <= half; k++) prevPh[k] = ph[k] as number;
    // rotate both channels by the mid's phase change (DC and Nyquist stay real)
    for (let k = 0; k <= half; k++) {
      if (k === 0 || k === half) continue;
      const rot = (synth[k] as number) - (ph[k] as number);
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const a = lRe[k] as number;
      const b = lIm[k] as number;
      lRe[k] = a * cr - b * sr;
      lIm[k] = a * sr + b * cr;
      const c = rRe[k] as number;
      const d = rIm[k] as number;
      rRe[k] = c * cr - d * sr;
      rIm[k] = c * sr + d * cr;
    }
    // back to one complex spectrum (L + i·R, Hermitian halves) and to time
    for (let k = 0; k <= half; k++) {
      re[k] = (lRe[k] as number) - (rIm[k] as number);
      im[k] = (lIm[k] as number) + (rRe[k] as number);
    }
    for (let k = half + 1; k < N; k++) {
      const j = N - k;
      re[k] = (lRe[j] as number) + (rIm[j] as number);
      im[k] = -(lIm[j] as number) + (rRe[j] as number);
    }
    fft.transform(re, im, true);
    const oStart = cOut - half;
    for (let n = 0; n < N; n++) {
      const t = oStart + n;
      if (t < 0 || t >= outLen) continue;
      const w = win[n] as number;
      outL[t] = (outL[t] as number) + (re[n] as number) * w;
      if (outR) outR[t] = (outR[t] as number) + (im[n] as number) * w;
      if (keep[n]) wsum[t] = (wsum[t] as number) + w * w;
    }
  }
  // overlap-add normalisation: Σ w² of the frames that saw each sample (1.5 where none was cut);
  // the inverse FFT is unscaled (× N)
  for (let t = 0; t < outLen; t++) {
    const g = 1 / (N * Math.max(0.25, wsum[t] as number));
    outL[t] = (outL[t] as number) * g;
    if (outR) outR[t] = (outR[t] as number) * g;
  }
  return outR ? [outL, outR] : [outL];
}
