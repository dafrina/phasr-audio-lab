/**
 * Sampler mapping — pure logic shared by the audio node, the UI and tests.
 *
 *  - Every sample is a zone with a root note (the pitch it was recorded at).
 *  - Auto mapping: key ranges split halfway between neighbouring roots, the
 *    outermost zones reach the ends of the keyboard, so every key plays
 *    something (pitched from the nearest sample = extrapolation). Samples
 *    sharing a root become velocity layers, quiet → loud.
 *  - Manual mapping: zones keep the ranges you set; keys or velocities no
 *    zone covers fall back to the nearest zone by pitch.
 *  - Root notes come from file names ("Piano_C4", "Bass A#1", "pad-060") or,
 *    failing that, from pitch detection on the audio.
 */

export interface SamplerZone {
  id: string;
  assetId: string;
  name: string;
  /** MIDI note the sample was recorded at */
  root: number;
  /** key range (inclusive), used in manual mapping */
  lo: number;
  hi: number;
  /** velocity range 1..127 (inclusive), used in manual mapping */
  velLo: number;
  velHi: number;
  /** fine tune in cents */
  tune: number;
  /** dB */
  gain: number;
  /** measured loudness (RMS dBFS) — orders automatic velocity layers */
  loudness: number;
}

export interface SamplerParams {
  /** seconds */
  attack: number;
  /** seconds */
  release: number;
  /** 0 = every note at full level, 1 = fully velocity dependent */
  velSens: number;
  /** dB */
  gain: number;
  /** semitones */
  transpose: number;
  /** 1 = ignore note-offs (play samples to their end) */
  oneShot: number;
}

export interface SamplerConfigData {
  zones: SamplerZone[];
  params: SamplerParams;
  /** true = ranges and layers are computed from the roots */
  autoMap: boolean;
}

export const DEFAULT_SAMPLER_PARAMS: SamplerParams = { attack: 0.002, release: 0.35, velSens: 0.7, gain: 0, transpose: 0, oneShot: 0 };

const clampInt = (x: unknown, lo: number, hi: number, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def);
const clampNum = (x: unknown, lo: number, hi: number, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);

export function sanitizeZone(raw: unknown): SamplerZone | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.assetId !== 'string' || !r.assetId) return null;
  const root = clampInt(r.root, 0, 127, 60);
  const lo = clampInt(r.lo, 0, 127, 0);
  const hi = clampInt(r.hi, 0, 127, 127);
  const velLo = clampInt(r.velLo, 1, 127, 1);
  const velHi = clampInt(r.velHi, 1, 127, 127);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `z_${r.assetId}`,
    assetId: r.assetId,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Sample',
    root,
    lo: Math.min(lo, hi),
    hi: Math.max(lo, hi),
    velLo: Math.min(velLo, velHi),
    velHi: Math.max(velLo, velHi),
    tune: clampNum(r.tune, -100, 100, 0),
    gain: clampNum(r.gain, -48, 12, 0),
    loudness: clampNum(r.loudness, -200, 20, -20),
  };
}

export function sanitizeSamplerParams(raw: unknown): SamplerParams {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SAMPLER_PARAMS;
  return {
    attack: clampNum(r.attack, 0.001, 5, d.attack),
    release: clampNum(r.release, 0.005, 10, d.release),
    velSens: clampNum(r.velSens, 0, 1, d.velSens),
    gain: clampNum(r.gain, -36, 12, d.gain),
    transpose: clampInt(r.transpose, -24, 24, d.transpose),
    oneShot: r.oneShot === 1 || r.oneShot === true ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Root note detection
// ---------------------------------------------------------------------------

const PCS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * Find a note in a sample's file name. Accepts note names with octave
 * (C4, c#3, Db2, A-1, F♯5; octave 4 = middle C = MIDI 60) and bare MIDI
 * numbers (21–108 written as 2–3 digits, e.g. "_060", "piano 72").
 * The last match wins ("Piano_mf_C4" → C4). Returns null if nothing fits.
 */
export function noteFromName(name: string): number | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  let found: number | null = null;
  // note names: letter, optional accidental, octave −1…9, not part of a longer word/number
  const re = /(?:^|[^a-z0-9])([a-g])(#|♯|b|♭|s)?(-?1|[0-9])(?![0-9])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(base))) {
    const pc = PCS[(m[1] as string).toLowerCase()] as number;
    const acc = m[2] ? (m[2] === 'b' || m[2] === '♭' ? -1 : 1) : 0;
    const oct = Number(m[3]);
    const n = (oct + 1) * 12 + pc + acc;
    if (n >= 0 && n <= 127) found = n;
  }
  if (found !== null) return found;
  const nums = [...base.matchAll(/(?:^|[^0-9])(\d{2,3})(?![0-9])/g)].map((x) => Number(x[1]));
  const midi = nums.filter((x) => x >= 21 && x <= 108);
  return midi.length ? (midi[midi.length - 1] as number) : null;
}

/**
 * Fundamental frequency of a (mostly) pitched sample via the YIN difference
 * function on a window after the attack. Returns MIDI note (fractional) and
 * a confidence 0…1, or null for unpitched material.
 */
export function detectPitch(data: Float32Array, sampleRate: number): { midi: number; confidence: number } | null {
  const start = Math.min(data.length, Math.round(0.06 * sampleRate));
  const W = Math.min(Math.round(0.08 * sampleRate), Math.floor((data.length - start) / 2));
  if (W < 256) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 4200));
  const maxLag = Math.min(W - 1, Math.floor(sampleRate / 27));
  const d = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = (data[start + i] as number) - (data[start + i + tau] as number);
      s += x * x;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  let run = 0;
  const cmnd = new Float64Array(maxLag + 1);
  cmnd[0] = 1;
  for (let tau = 1; tau <= maxLag; tau++) {
    run += d[tau] as number;
    cmnd[tau] = run > 0 ? ((d[tau] as number) * tau) / run : 1;
  }
  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if ((cmnd[t] as number) < 0.15) {
      while (t + 1 <= maxLag && (cmnd[t + 1] as number) < (cmnd[t] as number)) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // no clear dip: take the global minimum if it is reasonably deep
    let best = minLag;
    for (let t = minLag; t <= maxLag; t++) if ((cmnd[t] as number) < (cmnd[best] as number)) best = t;
    if ((cmnd[best] as number) > 0.4) return null;
    tau = best;
  }
  // parabolic refinement
  const a = cmnd[tau - 1] ?? cmnd[tau] ?? 1;
  const b = cmnd[tau] as number;
  const c = cmnd[tau + 1] ?? b;
  const den = a - 2 * b + c;
  const t = tau + (den !== 0 ? (0.5 * (a - c)) / den : 0);
  const f = sampleRate / t;
  return { midi: 69 + 12 * Math.log2(f / 440), confidence: Math.max(0, Math.min(1, 1 - b)) };
}

/** RMS loudness (dBFS) of the first second — orders velocity layers. */
export function loudnessDb(data: Float32Array, sampleRate: number): number {
  const n = Math.min(data.length, sampleRate);
  let s = 0;
  for (let i = 0; i < n; i++) s += (data[i] as number) ** 2;
  return n ? 10 * Math.log10(s / n + 1e-20) : -200;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface MappedZone extends SamplerZone {
  /** effective ranges after auto mapping */
  keyLo: number;
  keyHi: number;
  vLo: number;
  vHi: number;
}

/** Effective key/velocity ranges of every zone (auto mapping computes them from the roots). */
export function mapZones(cfg: SamplerConfigData): MappedZone[] {
  if (!cfg.autoMap) return cfg.zones.map((z) => ({ ...z, keyLo: z.lo, keyHi: z.hi, vLo: z.velLo, vHi: z.velHi }));
  const roots = [...new Set(cfg.zones.map((z) => z.root))].sort((a, b) => a - b);
  const out: MappedZone[] = [];
  roots.forEach((root, i) => {
    const prev = roots[i - 1];
    const next = roots[i + 1];
    // split halfway; on an odd gap the extra key goes to the upper sample (pitching down sounds better)
    const keyLo = prev === undefined ? 0 : Math.floor((prev + root) / 2) + 1;
    const keyHi = next === undefined ? 127 : Math.floor((root + next) / 2);
    const layers = cfg.zones.filter((z) => z.root === root).sort((a, b) => a.loudness - b.loudness || a.id.localeCompare(b.id));
    layers.forEach((z, j) => {
      const vLo = Math.round((j * 127) / layers.length) + 1;
      const vHi = Math.round(((j + 1) * 127) / layers.length);
      out.push({ ...z, keyLo, keyHi, vLo: Math.min(vLo, vHi), vHi });
    });
  });
  return out;
}

/**
 * The zone that plays a note: one whose key and velocity ranges contain it;
 * otherwise the nearest by pitch (and then by velocity) — extrapolation.
 */
export function zoneFor(mapped: readonly MappedZone[], note: number, velocity127: number): MappedZone | null {
  if (!mapped.length) return null;
  let best: MappedZone | null = null;
  let bestScore = Infinity;
  for (const z of mapped) {
    const keyDist = note < z.keyLo ? z.keyLo - note : note > z.keyHi ? note - z.keyHi : 0;
    const velDist = velocity127 < z.vLo ? z.vLo - velocity127 : velocity127 > z.vHi ? velocity127 - z.vHi : 0;
    // inside both ranges wins; then fewest keys away (pitch-shift less), then velocity, then closest root
    const score = keyDist * 1000 + velDist * 10 + Math.abs(note - z.root) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = z;
    }
  }
  return best;
}

/** Playback rate for a note on a zone (equal temperament around the root). */
export function playbackRate(zone: Pick<SamplerZone, 'root' | 'tune'>, note: number, transpose = 0, bendSemitones = 0): number {
  return Math.pow(2, (note + transpose + bendSemitones - zone.root + zone.tune / 100) / 12);
}

/** Notes no zone covers in manual mapping (they borrow the nearest zone). */
export function uncoveredKeys(mapped: readonly MappedZone[]): number[] {
  const out: number[] = [];
  for (let n = 0; n < 128; n++) if (!mapped.some((z) => n >= z.keyLo && n <= z.keyHi)) out.push(n);
  return out;
}
