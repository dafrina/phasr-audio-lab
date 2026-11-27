/**
 * Reverb Pro's room view.
 *
 *  - left: the room, drawn so every setting is visible — Size and Decay set
 *    its real size (one metric scale: a bigger room is drawn bigger) and
 *    height; Damping is the wall material (thin bright tile/stone → thick
 *    padded curtains), and each bounce loses more energy; Early is how
 *    bright the first reflections and their wall hits are; Pre-delay moves
 *    the source further from you; Width is your stereo wedge; Mix and Decay
 *    set how strongly and how long the room glows. Reflections are
 *    image-source paths (order 1–3, more for longer decays).
 *  - right: the impulse response the reverb really convolves with
 *    (generateImpulse at the context's sample rate): spectrogram with the
 *    tail EQ's cut bands, energy decay curve (Schroeder integration), the
 *    −60 dB point, the pre-delay gap and the early-reflection ticks.
 *
 * Every room change morphs the drawing and "pings" the room: a wavefront
 * leaves the source, the paths light up as it reaches them, the walls flash
 * where it bounces, then the room glows and fades with the decay (click to
 * ping again). Animation runs only during a ping (≈ 1.6 s) and not at all
 * with prefers-reduced-motion; the impulse view is computed once per change
 * (debounced while dragging) and cached in its own layer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { generateImpulse, type ImpulseShape } from '../../audio/effects/impulse';
import type { ReverbParams } from '../../project/types';
import { engine } from '../../audio/engine';

const W = 464;
const H = 150;
const ROOM_W = 168;
const BANDS = 44;
const C_SOUND = 343;
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

/** what the room drawing shows, in metres and 0..1 amounts (interpolated while the room morphs) */
interface RoomGeom {
  width: number;
  depth: number;
  height: number;
  /** source position (metres): pre-delay moves it away from the listener */
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  damping: number;
  early: number;
  decay: number;
  stereo: number;
  mix: number;
}

function geomFor(p: ReverbParams): RoomGeom {
  // room size from the decay (bigger rooms ring longer) and the Size knob: width 3 … 60 m
  const width = Math.min(60, Math.max(3, (4 + 7.5 * Math.sqrt(p.decay)) * p.size));
  const depth = width * 0.68;
  const height = Math.min(18, Math.max(2.4, (2.6 + 1.6 * Math.sqrt(p.decay)) * Math.sqrt(p.size)));
  const far = Math.min(1, p.preDelay / 0.12);
  return {
    width,
    depth,
    height,
    sx: width * (0.36 - 0.24 * far),
    sy: depth * (0.42 - 0.22 * far),
    lx: width * 0.68,
    ly: depth * 0.64,
    damping: p.damping,
    early: p.early,
    decay: p.decay,
    stereo: p.width,
    mix: p.mix,
  };
}

const lerpGeom = (a: RoomGeom, b: RoomGeom, k: number): RoomGeom => {
  const o = { ...b };
  for (const key of Object.keys(b) as (keyof RoomGeom)[]) o[key] = a[key] + (b[key] - a[key]) * k;
  return o;
};

/** the ping: how long (s) the wavefront, the reflections and the glow take on screen */
const PING_SEC = 1.6;
const MORPH_SEC = 0.35;

export function ReverbRoomView({ params, color }: { params: ReverbParams; color: string }) {
  const { decay, preDelay, mix, size } = params;
  const canvas = useRef<HTMLCanvasElement>(null);
  const specLayer = useRef<HTMLCanvasElement | null>(null);
  const geomNow = useRef<RoomGeom | null>(null);
  const anim = useRef<{ from: RoomGeom; to: RoomGeom; start: number } | null>(null);
  const raf = useRef(0);
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
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const draw = (geom: RoomGeom, ping: number | null) => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0a0a12';
    g.fillRect(0, 0, cv.width, cv.height);
    if (specLayer.current) g.drawImage(specLayer.current, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoom(g, geom, a, color, ping);
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // the impulse view (right): drawn once per change into its own layer
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const layer = (specLayer.current ??= document.createElement('canvas'));
    layer.width = Math.round(W * dpr);
    layer.height = Math.round(H * dpr);
    const g = layer.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    drawSpectrum(g, decay, preDelay, mix, a, color, params.lowCut, params.highCut);
    if (!anim.current && geomNow.current) drawRef.current(geomNow.current, null);
  }, [a, decay, preDelay, mix, color, params.lowCut, params.highCut]);

  const start = (to: RoomGeom) => {
    const from = geomNow.current ?? to;
    if (reduce) {
      geomNow.current = to;
      drawRef.current(to, null);
      return;
    }
    anim.current = { from, to, start: performance.now() };
    cancelAnimationFrame(raf.current);
    const frame = (now: number) => {
      const an = anim.current;
      if (!an) return;
      // (a frame's timestamp can be a hair earlier than the start)
      const t = Math.max(0, (now - an.start) / 1000);
      const k = Math.min(1, t / MORPH_SEC);
      const geom = lerpGeom(an.from, an.to, 1 - (1 - k) * (1 - k));
      geomNow.current = geom;
      drawRef.current(geom, t < PING_SEC ? t : null);
      if (t < PING_SEC) raf.current = requestAnimationFrame(frame);
      else anim.current = null;
    };
    raf.current = requestAnimationFrame(frame);
  };

  // a room setting changed: morph to the new room and ping it
  const roomKey = `${decay}|${size}|${params.damping}|${params.early}|${preDelay}|${params.width}|${mix}`;
  useEffect(() => {
    start(geomFor(params));
    // (the ping replays on every room change; the geometry comes from the params)
  }, [roomKey, color]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <canvas
      ref={canvas}
      style={{ width: W, height: H }}
      className="cursor-pointer rounded"
      aria-label="Reverb room and impulse response"
      title="The room: click to ping it again"
      onClick={() => start(geomFor(params))}
    />
  );
}

/** wall material from the damping: hard and bright → soft and warm */
function wallColor(damping: number): string {
  const hard = [190, 205, 230];
  const soft = [150, 88, 112];
  const c = hard.map((v, i) => Math.round(v + ((soft[i] as number) - v) * damping));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const materialName = (d: number) => (d < 0.2 ? 'glass / tile' : d < 0.4 ? 'stone' : d < 0.6 ? 'wood' : d < 0.8 ? 'plaster + rugs' : 'curtains');

function drawRoom(g: CanvasRenderingContext2D, geo: RoomGeom, a: Analysis, color: string, ping: number | null): void {
  const { width, depth, height } = geo;
  // a fixed metric scale (√, so a 4 m booth and a 60 m cathedral both fit): bigger rooms ARE bigger
  const maxW = ROOM_W - 26;
  const rw = 26 + (maxW - 26) * Math.sqrt(Math.min(1, width / 60));
  const rd = rw * (depth / width);
  const lift = 3 + 11 * Math.sqrt(Math.min(1, height / 18));
  const s = rw / width;
  const ox = (ROOM_W - rw - lift) / 2;
  const oy = 16 + lift + (H - 32 - lift - rd) / 2;
  const wall = wallColor(geo.damping);
  const thick = 1 + 4 * geo.damping;
  // pinged? t ≥ 0: seconds into the ping
  const t = ping ?? Infinity;
  const px = (p: { x: number; y: number }) => ({ x: ox + p.x * s, y: oy + p.y * s });
  const S = { x: geo.sx, y: geo.sy };
  const L = { x: geo.lx, y: geo.ly };
  const ps = px(S);
  const pl = px(L);
  // diffuse field: the room glows with the reverb (longer decay → longer glow; tinted by the walls)
  const glowBase = Math.min(0.55, 0.12 + 0.35 * geo.mix + 0.04 * geo.decay);
  let glow = glowBase;
  if (ping !== null) {
    const arrive = 0.55;
    glow = t < arrive ? glowBase * (t / arrive) * 1.6 : glowBase * (0.35 + 1.25 * Math.exp(-(t - arrive) / (0.15 + geo.decay / 8)));
  }
  const grad = g.createRadialGradient(ps.x, ps.y, 2, ps.x, ps.y, Math.max(rw, rd));
  grad.addColorStop(0, withAlpha(color, Math.min(0.8, glow)));
  grad.addColorStop(1, withAlpha(color, Math.min(0.8, glow) * 0.15));
  g.fillStyle = '#10101a';
  g.fillRect(ox, oy, rw, rd);
  g.fillStyle = grad;
  g.fillRect(ox, oy, rw, rd);
  // far walls and ceiling edges (the height)
  g.strokeStyle = withAlpha(wall, 0.35);
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
  // reflections: image sources (order 1 … 3: longer decays show more of the web); each bounce loses
  // energy to the walls (damping); the first bounces follow the Early knob
  const rho = 1 - 0.8 * geo.damping;
  const maxOrder = geo.decay < 1 ? 1 : geo.decay < 3 ? 2 : 3;
  const X = (n: number) => n * width + (n % 2 === 0 ? S.x : width - S.x);
  const Y = (n: number) => n * depth + (n % 2 === 0 ? S.y : depth - S.y);
  const rays: { pts: { x: number; y: number }[]; strength: number; order: number; len: number }[] = [];
  for (let nx = -2; nx <= 2; nx++) {
    for (let ny = -2; ny <= 2; ny++) {
      const order = Math.abs(nx) + Math.abs(ny);
      if (order === 0 || order > maxOrder) continue;
      const im = { x: X(nx), y: Y(ny), w: '' };
      const pts = reflectionPath(S, L, im, width, depth).reverse();
      let strength = Math.pow(rho, order) * (order === 1 ? Math.min(2, geo.early) : 0.8);
      if (geo.early < 0.05 && order === 1) strength = 0;
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += Math.hypot((pts[k] as { x: number }).x - (pts[k - 1] as { x: number }).x, (pts[k] as { y: number }).y - (pts[k - 1] as { y: number }).y);
      rays.push({ pts, strength, order, len });
    }
  }
  const direct = Math.hypot(L.x - S.x, L.y - S.y);
  const longest = rays.reduce((m, r) => Math.max(m, r.len), direct);
  // the ping's wavefront: metres travelled so far (the whole web is reached in ~0.5 s)
  const front = ping === null ? Infinity : (t / 0.5) * longest;
  for (const r of rays.sort((x, y) => y.order - x.order)) {
    if (r.strength <= 0.01) continue;
    const alpha = Math.min(0.95, 0.12 + 0.6 * r.strength);
    g.strokeStyle = withAlpha(color, alpha);
    g.lineWidth = r.order === 1 ? 0.8 + 0.6 * Math.min(2, geo.early) : r.order === 2 ? 0.8 : 0.6;
    g.setLineDash(r.order === 1 ? [] : r.order === 2 ? [2, 2] : [1, 3]);
    g.beginPath();
    let walked = 0;
    for (let k = 0; k < r.pts.length; k++) {
      const p = r.pts[k] as { x: number; y: number };
      const q = px(p);
      if (k === 0) {
        g.moveTo(q.x, q.y);
        continue;
      }
      const prev = r.pts[k - 1] as { x: number; y: number };
      const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (walked + seg <= front) {
        g.lineTo(q.x, q.y);
        walked += seg;
      } else {
        const f = Math.max(0, (front - walked) / seg);
        const qq = px({ x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f });
        g.lineTo(qq.x, qq.y);
        break;
      }
    }
    g.stroke();
    // bounce points on the walls: flash as the wavefront hits them
    g.setLineDash([]);
    let along = 0;
    for (let k = 1; k < r.pts.length - 1; k++) {
      const p = r.pts[k] as { x: number; y: number };
      const prev = r.pts[k - 1] as { x: number; y: number };
      along += Math.hypot(p.x - prev.x, p.y - prev.y);
      if (along > front) break;
      const since = ping === null ? 1 : t - (along / longest) * 0.5;
      const flash = ping === null ? 0 : Math.max(0, 1 - since / 0.25);
      const q = px(p);
      const rad = (r.order === 1 ? 1.2 + 1.3 * Math.min(2, geo.early) : 1) + 3 * flash;
      g.fillStyle = withAlpha('#ffffff', Math.min(1, (0.3 + 0.6 * r.strength) * (1 + flash)));
      g.beginPath();
      g.arc(q.x, q.y, rad, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.setLineDash([]);
  // walls on top: thick and warm when damped (with absorber panels), thin and bright when hard
  g.strokeStyle = wall;
  g.lineWidth = thick;
  g.strokeRect(ox + thick / 2, oy + thick / 2, rw - thick, rd - thick);
  if (geo.damping > 0.55) {
    g.strokeStyle = withAlpha(wall, 0.6);
    g.lineWidth = 1;
    const step = 7;
    g.beginPath();
    for (let x = ox + 4; x < ox + rw - 2; x += step) {
      g.moveTo(x, oy + thick + 1);
      g.lineTo(x + 2, oy + thick + 3);
      g.moveTo(x, oy + rd - thick - 1);
      g.lineTo(x + 2, oy + rd - thick - 3);
    }
    g.stroke();
  }
  // the ping's wavefront ring (clipped to the room)
  if (ping !== null && front < longest * 1.05) {
    g.save();
    g.beginPath();
    g.rect(ox, oy, rw, rd);
    g.clip();
    const fade = 1 - Math.min(1, t / 0.55);
    for (const [r, al] of [
      [front, 0.9],
      [front * 0.72, 0.4],
    ] as const) {
      g.strokeStyle = withAlpha('#ffffff', al * fade);
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(ps.x, ps.y, Math.max(0, r * s), 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }
  // direct sound
  if (front > 0) {
    const f = Math.min(1, front / direct);
    g.strokeStyle = '#e8e8f2';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(ps.x, ps.y);
    g.lineTo(ps.x + (pl.x - ps.x) * f, ps.y + (pl.y - ps.y) * f);
    g.stroke();
  }
  // the listener's stereo field (width): a wedge, a line when mono
  const spread = (Math.PI / 180) * (4 + 70 * Math.min(1.5, geo.stereo));
  const dir = Math.atan2(ps.y - pl.y, ps.x - pl.x) + Math.PI;
  g.fillStyle = withAlpha('#facc15', 0.18);
  g.beginPath();
  g.moveTo(pl.x, pl.y);
  g.arc(pl.x, pl.y, 16, dir - spread / 2, dir + spread / 2);
  g.closePath();
  g.fill();
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
  g.textBaseline = 'top';
  g.fillStyle = '#8b8ba6';
  g.fillText('src', ps.x - 7, ps.y + 6);
  g.fillText('you', pl.x - 7, pl.y + 6);
  // labels
  g.fillStyle = '#a6a6c2';
  g.fillText(`≈ ${width.toFixed(0)} × ${depth.toFixed(0)} × ${height.toFixed(0)} m`, 6, H - 12);
  g.fillStyle = wall;
  g.fillText(materialName(geo.damping), ROOM_W - 6 - g.measureText(materialName(geo.damping)).width, H - 12);
  const first = rays.filter((r) => r.order === 1).reduce((m, r) => Math.min(m, r.len), Infinity);
  const firstMs = Number.isFinite(first) ? Math.round(((first - direct) / C_SOUND) * 1000) : 0;
  g.fillStyle = '#6a6a86';
  g.fillText(geo.early < 0.05 ? 'no early echoes' : `1st echo +${firstMs} ms`, 6, 2);
  void a;
}

/** Polyline from source to listener reflecting off the walls named in `im.w` (image-source method). */
function reflectionPath(S: { x: number; y: number }, L: { x: number; y: number }, im: { x: number; y: number; w: string }, width: number, depth: number): { x: number; y: number }[] {
  // straight line from the listener to the image, folded back into the room
  // fine enough that even a third-order path never crosses two walls in one step
  const steps = 192;
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
