/**
 * Reverb Pro's room view, drawn from the impulse response the reverb really
 * convolves with (generateImpulse at the context's sample rate):
 *
 *  - left: a floor plan of a room sized for the decay time (Sabine-style:
 *    longer decay → bigger room), with the source, the listener, the direct
 *    path and the early reflections found in the IR, drawn as image-source
 *    rays off the walls (brighter = louder reflection);
 *  - right: the IR's spectrogram (time → right, frequency ↑, energy as
 *    colour) — the tail darkens as the room absorbs the highs — with the
 *    energy decay curve (Schroeder integration) on top, the −60 dB point,
 *    the pre-delay gap and the early-reflection ticks.
 *
 * Computed once per decay / pre-delay change (debounced while dragging) and
 * drawn on a canvas; nothing animates per frame.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { generateImpulse, type ImpulseShape } from '../../audio/effects/impulse';
import type { ReverbParams } from '../../project/types';
import { engine } from '../../audio/engine';

const W = 464;
const H = 150;
const ROOM_W = 168;
const BANDS = 44;
const FRAMES = 120;
const FFT_N = 1024;
const F_LO = 60;
const F_HI = 18000;

interface Analysis {
  /** FRAMES × BANDS dB values, frame-major */
  spec: Float32Array;
  /** energy decay curve in dB at each frame */
  edc: Float32Array;
  /** early reflections: time (s) and relative level 0..1 */
  reflections: { t: number; a: number }[];
  /** seconds covered by the IR */
  irSec: number;
}

/** in-place radix-2 FFT (re, im), n a power of two */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function analyse(decay: number, shape: ImpulseShape, sr: number): Analysis {
  const [ir] = generateImpulse(sr, decay, shape);
  const n = ir.length;
  const irSec = n / sr;
  // spectrogram
  const spec = new Float32Array(FRAMES * BANDS);
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  const win = new Float64Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
  const bandEdges = Array.from({ length: BANDS + 1 }, (_, b) => F_LO * Math.pow(F_HI / F_LO, b / BANDS));
  const binHz = sr / FFT_N;
  for (let f = 0; f < FRAMES; f++) {
    const start = Math.floor((f / FRAMES) * Math.max(1, n - FFT_N));
    for (let i = 0; i < FFT_N; i++) {
      re[i] = ((ir[start + i] as number | undefined) ?? 0) * (win[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const k0 = Math.max(1, Math.floor((bandEdges[b] as number) / binHz));
      const k1 = Math.max(k0 + 1, Math.ceil((bandEdges[b + 1] as number) / binHz));
      let p = 0;
      for (let k = k0; k < k1 && k < FFT_N / 2; k++) p += (re[k] as number) ** 2 + (im[k] as number) ** 2;
      spec[f * BANDS + b] = 10 * Math.log10(p / (k1 - k0) + 1e-20);
    }
  }
  // energy decay curve (backward integration of the squared IR)
  const edc = new Float32Array(FRAMES);
  let total = 0;
  for (let i = 0; i < n; i++) total += (ir[i] as number) ** 2;
  let acc = total;
  let idx = 0;
  for (let f = 0; f < FRAMES; f++) {
    const upto = Math.floor((f / FRAMES) * n);
    for (; idx < upto; idx++) acc -= (ir[idx] as number) ** 2;
    edc[f] = 10 * Math.log10(Math.max(acc, 1e-30) / total);
  }
  // early reflections: spikes in the first 90 ms (× size) that stand well above their surroundings
  const reflections: { t: number; a: number }[] = [];
  const erEnd = Math.min(n, Math.round(0.09 * (shape.size ?? 1) * sr));
  const hw = Math.round(0.002 * sr);
  let peak = 0;
  for (let i = 0; i < erEnd; i++) peak = Math.max(peak, Math.abs(ir[i] as number));
  for (let i = hw; i < erEnd - hw; i++) {
    const v = Math.abs(ir[i] as number);
    if (v < peak * 0.25) continue;
    let local = 0;
    for (let j = i - hw; j <= i + hw; j++) if (j !== i) local = Math.max(local, Math.abs(ir[j] as number));
    if (v > local * 1.6) reflections.push({ t: i / sr, a: v / peak });
  }
  return { spec, edc, reflections: reflections.slice(0, 14), irSec };
}

/** heat colour 0..1: deep blue → violet → pink → warm white */
function heat(x: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, x));
  const stops: [number, number, number, number][] = [
    [0, 8, 8, 18],
    [0.35, 52, 32, 120],
    [0.6, 155, 138, 255],
    [0.82, 244, 114, 182],
    [1, 255, 240, 220],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, r1, g1, b1] = stops[i] as [number, number, number, number];
    const [p0, r0, g0, b0] = stops[i - 1] as [number, number, number, number];
    if (t <= p1) {
      const u = (t - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u];
    }
  }
  return [255, 240, 220];
}

export function ReverbRoomView({ params, color }: { params: ReverbParams; color: string }) {
  const { decay, preDelay, mix, size } = params;
  const canvas = useRef<HTMLCanvasElement>(null);
  // follow the knobs, but rebuild the analysis only once they rest for a moment
  const key = `${decay}|${size}|${params.damping}|${params.early}`;
  const [shown, setShown] = useState({ key, decay, shape: { size, damping: params.damping, early: params.early } });
  useEffect(() => {
    if (key === shown.key) return;
    const t = setTimeout(() => setShown({ key, decay, shape: { size, damping: params.damping, early: params.early } }), 90);
    return () => clearTimeout(t);
  }, [key, shown.key, decay, size, params.damping, params.early]);
  const sr = engine.ctx?.sampleRate ?? 48000;
  const a = useMemo(() => analyse(shown.decay, shown.shape, sr), [shown, sr]);

  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0a0a12';
    g.fillRect(0, 0, W, H);
    drawRoom(g, decay, size, preDelay, a, color);
    drawSpectrum(g, decay, preDelay, mix, a, color, params.lowCut, params.highCut);
  }, [a, decay, size, preDelay, mix, color, params.lowCut, params.highCut]);

  return <canvas ref={canvas} style={{ width: W, height: H }} className="rounded" aria-label="Reverb room and impulse response" />;
}

function drawRoom(g: CanvasRenderingContext2D, decay: number, size: number, preDelay: number, a: Analysis, color: string): void {
  // room size from the decay (bigger rooms ring longer) and the Size knob: width 3 … 60 m
  const width = Math.min(60, Math.max(3, (4 + 7.5 * Math.sqrt(decay)) * size));
  const depth = width * 0.68;
  const height = Math.min(18, 2.6 + 1.6 * Math.sqrt(decay));
  const pad = 14;
  const sx = (ROOM_W - 2 * pad) / width;
  const sy = (H - 2 * pad - 12) / depth;
  const s = Math.min(sx, sy);
  const rw = width * s;
  const rd = depth * s;
  const ox = (ROOM_W - rw) / 2;
  const oy = pad + (H - 2 * pad - 12 - rd) / 2;
  // floor + walls (a slight 3D offset for the far walls)
  const lift = 7;
  g.fillStyle = '#12121e';
  g.fillRect(ox, oy, rw, rd);
  g.strokeStyle = '#2c2c44';
  g.lineWidth = 1;
  g.strokeRect(ox + lift, oy - lift, rw, rd);
  g.beginPath();
  for (const [x, y] of [
    [ox, oy],
    [ox + rw, oy],
    [ox, oy + rd],
    [ox + rw, oy + rd],
  ] as const) {
    g.moveTo(x, y);
    g.lineTo(x + lift, y - lift);
  }
  g.stroke();
  g.strokeStyle = '#4a4a6a';
  g.strokeRect(ox + 0.5, oy + 0.5, rw - 1, rd - 1);
  // source and listener (metres, then px)
  const S = { x: width * 0.3, y: depth * 0.38 };
  const L = { x: width * 0.68, y: depth * 0.66 };
  const px = (p: { x: number; y: number }) => ({ x: ox + p.x * s, y: oy + p.y * s });
  // reflections: image sources across the four walls (first order), then corners (second order)
  const images = [
    { x: -S.x, y: S.y, w: 'L' },
    { x: 2 * width - S.x, y: S.y, w: 'R' },
    { x: S.x, y: -S.y, w: 'T' },
    { x: S.x, y: 2 * depth - S.y, w: 'B' },
    { x: -S.x, y: -S.y, w: 'LT' },
    { x: 2 * width - S.x, y: 2 * depth - S.y, w: 'RB' },
    { x: -S.x, y: 2 * depth - S.y, w: 'LB' },
    { x: 2 * width - S.x, y: -S.y, w: 'RT' },
  ];
  const refl = a.reflections.length ? a.reflections : [{ t: 0.01, a: 0.5 }];
  images.forEach((im, i) => {
    const r = refl[i % refl.length] as { t: number; a: number };
    const strength = Math.min(1, 0.25 + r.a) * (i < 4 ? 1 : 0.55);
    // path: source → wall point(s) → listener, found by walking towards the image
    const pts = reflectionPath(S, L, im, width, depth);
    g.strokeStyle = withAlpha(color, 0.18 + 0.55 * strength);
    g.lineWidth = i < 4 ? 1.2 : 0.8;
    g.setLineDash(i < 4 ? [] : [2, 2]);
    g.beginPath();
    pts.forEach((p, k) => {
      const q = px(p);
      if (k) g.lineTo(q.x, q.y);
      else g.moveTo(q.x, q.y);
    });
    g.stroke();
    // bounce points
    g.setLineDash([]);
    g.fillStyle = withAlpha('#ffffff', 0.35 + 0.5 * strength);
    for (const p of pts.slice(1, -1)) {
      const q = px(p);
      g.fillRect(q.x - 1, q.y - 1, 2, 2);
    }
  });
  g.setLineDash([]);
  // direct path
  const ps = px(S);
  const pl = px(L);
  g.strokeStyle = '#e8e8f2';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(ps.x, ps.y);
  g.lineTo(pl.x, pl.y);
  g.stroke();
  // source (speaker) and listener (head)
  g.fillStyle = color;
  g.beginPath();
  g.arc(ps.x, ps.y, 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#facc15';
  g.beginPath();
  g.arc(pl.x, pl.y, 4, 0, Math.PI * 2);
  g.fill();
  g.font = '9px ui-monospace, Menlo, monospace';
  g.fillStyle = '#8b8ba6';
  g.textBaseline = 'top';
  g.fillText('src', ps.x - 7, ps.y + 6);
  g.fillText('you', pl.x - 7, pl.y + 6);
  // dimensions
  g.fillStyle = '#a6a6c2';
  g.fillText(`≈ ${width.toFixed(0)} × ${depth.toFixed(0)} × ${height.toFixed(0)} m`, 6, H - 12);
  const firstMs = Math.round((preDelay + (refl[0]?.t ?? 0)) * 1000);
  g.fillStyle = '#6a6a86';
  g.fillText(`1st echo ${firstMs} ms`, 6, 2);
}

/** Polyline from source to listener reflecting off the walls named in `im.w` (image-source method). */
function reflectionPath(S: { x: number; y: number }, L: { x: number; y: number }, im: { x: number; y: number; w: string }, width: number, depth: number): { x: number; y: number }[] {
  // straight line from the listener to the image, folded back into the room
  const steps = 64;
  const out: { x: number; y: number }[] = [L];
  let prevFold: { fx: number; fy: number } | null = null;
  const fold = (v: number, size: number) => {
    const m = ((v % (2 * size)) + 2 * size) % (2 * size);
    return m <= size ? m : 2 * size - m;
  };
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const x = L.x + (im.x - L.x) * t;
    const y = L.y + (im.y - L.y) * t;
    const fx = Math.floor(x / width);
    const fy = Math.floor(y / depth);
    if (prevFold && (fx !== prevFold.fx || fy !== prevFold.fy)) {
      // crossed a wall between the previous step and this one: add the bounce point
      const tb = t - 0.5 / steps;
      out.push({ x: fold(L.x + (im.x - L.x) * tb, width), y: fold(L.y + (im.y - L.y) * tb, depth) });
    }
    prevFold = { fx, fy };
  }
  out.push(S);
  return out;
}

function drawSpectrum(g: CanvasRenderingContext2D, decay: number, preDelay: number, mix: number, a: Analysis, color: string, lowCut: number, highCut: number): void {
  const x0 = ROOM_W + 8;
  const w = W - x0 - 6;
  const y0 = 8;
  const h = H - y0 - 18;
  const totalSec = preDelay + a.irSec;
  const tx = (sec: number) => x0 + (sec / totalSec) * w;
  // spectrogram image (frames × bands), placed after the pre-delay
  let max = -Infinity;
  for (const v of a.spec) max = Math.max(max, v);
  const img = g.createImageData(FRAMES, BANDS);
  for (let f = 0; f < FRAMES; f++) {
    for (let b = 0; b < BANDS; b++) {
      const db = (a.spec[f * BANDS + b] as number) - max;
      const [r, gg, bb] = heat((db + 72) / 72);
      const o = ((BANDS - 1 - b) * FRAMES + f) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = bb;
      img.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = FRAMES;
  tmp.height = BANDS;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.fillStyle = '#07070d';
  g.fillRect(x0, y0, w, h);
  g.drawImage(tmp, tx(preDelay), y0, w * (a.irSec / totalSec), h);
  // tail EQ: the cut regions (frequency is log from 60 Hz at the bottom to 18 kHz at the top)
  const yHz = (hzv: number) => y0 + h - (Math.log(Math.max(F_LO, Math.min(F_HI, hzv)) / F_LO) / Math.log(F_HI / F_LO)) * h;
  g.fillStyle = 'rgba(7,7,13,0.62)';
  if (lowCut > 20.5) g.fillRect(tx(preDelay), yHz(lowCut), x0 + w - tx(preDelay), y0 + h - yHz(lowCut));
  if (highCut < 19900) g.fillRect(tx(preDelay), y0, x0 + w - tx(preDelay), yHz(highCut) - y0);
  // pre-delay gap
  if (preDelay > 0.002) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x0, y0, tx(preDelay) - x0, h);
    g.fillStyle = '#6a6a86';
    g.font = '8px ui-monospace, Menlo, monospace';
    g.textBaseline = 'top';
    if (tx(preDelay) - x0 > 16) g.fillText('pre', x0 + 2, y0 + 2);
  }
  // energy decay curve (0 … −70 dB over the height)
  const yDb = (db: number) => y0 + (Math.min(0, Math.max(-70, db)) / -70) * h;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.3;
  g.beginPath();
  for (let f = 0; f < FRAMES; f++) {
    const x = tx(preDelay + (f / FRAMES) * a.irSec);
    const y = yDb(a.edc[f] as number);
    if (f) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  // −60 dB point
  const x60 = tx(preDelay + decay);
  g.strokeStyle = withAlpha('#facc15', 0.8);
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(x0, yDb(-60));
  g.lineTo(x0 + w, yDb(-60));
  g.moveTo(x60, y0);
  g.lineTo(x60, y0 + h);
  g.stroke();
  g.setLineDash([]);
  // early reflections on the time axis
  g.strokeStyle = withAlpha(color, 0.95);
  for (const r of a.reflections) {
    const x = tx(preDelay + r.t);
    g.beginPath();
    g.moveTo(x, y0 + h);
    g.lineTo(x, y0 + h - 4 - 10 * r.a);
    g.stroke();
  }
  // axes and labels
  g.font = '9px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  g.fillStyle = '#8b8ba6';
  g.fillText('0', x0, y0 + h + 3);
  const secLabel = totalSec < 10 ? `${totalSec.toFixed(1)} s` : `${totalSec.toFixed(0)} s`;
  g.fillText(secLabel, x0 + w - g.measureText(secLabel).width, y0 + h + 3);
  g.fillStyle = '#facc15';
  g.fillText(`RT60 ${decay.toFixed(2)} s`, Math.min(x60 + 3, x0 + w - 70), y0 + 2);
  g.fillStyle = '#a6a6c2';
  g.fillText('18k', x0 + 2, y0 + 12);
  g.fillText('60', x0 + 2, y0 + h - 11);
  g.fillStyle = '#6a6a86';
  g.fillText(`wet ${Math.round(mix * 100)}%`, x0 + w / 2 - 20, y0 + h + 3);
}

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}
