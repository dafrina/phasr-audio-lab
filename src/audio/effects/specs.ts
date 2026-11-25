/**
 * Insert effect definitions: parameter specs (ranges/defaults/formatting),
 * factory presets, validation and tail-length estimates. Pure module — no
 * Web Audio here, so it is shared by UI, engine, persistence and tests.
 */
import { createId } from '../../core/ids';
import type {
  CompressorParams,
  DelayParams,
  EffectSlot,
  EffectType,
  ChorusParams,
  EqParams,
  PeqBand,
  PeqBandType,
  PeqParams,
  PeqSlope,
  ReverbParams,
} from '../../project/types';
import type { NumericParamSpec } from '../../synth/params';

export const EFFECT_TYPES: EffectType[] = ['eq', 'peq', 'compressor', 'delay', 'chorus', 'reverb'];

export const EFFECT_LABELS: Record<EffectType, string> = {
  eq: 'EQ-3',
  peq: 'Spectra EQ',
  chorus: 'Chorus / Flanger',
  compressor: 'Compressor',
  delay: 'Delay',
  reverb: 'Reverb',
};

const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`);
const ms = (v: number) => (v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${v.toFixed(2)} s`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

export const EQ_SPECS = {
  lowGain: { label: 'Low', min: -18, max: 18, default: 0, curve: 'linear', bipolar: true, format: db },
  midGain: { label: 'Mid', min: -18, max: 18, default: 0, curve: 'linear', bipolar: true, format: db },
  highGain: { label: 'High', min: -18, max: 18, default: 0, curve: 'linear', bipolar: true, format: db },
  midFreq: { label: 'Mid Freq', min: 150, max: 8000, default: 1000, curve: 'exp', format: hz },
} satisfies Record<keyof EqParams, NumericParamSpec>;

export const COMP_SPECS = {
  threshold: { label: 'Thresh', min: -60, max: 0, default: -18, curve: 'linear', format: db },
  ratio: { label: 'Ratio', min: 1, max: 20, default: 4, curve: 'exp', format: (v) => `${v.toFixed(1)}:1` },
  attack: { label: 'Attack', min: 0.001, max: 0.3, default: 0.01, curve: 'exp', format: ms },
  release: { label: 'Release', min: 0.02, max: 1, default: 0.15, curve: 'exp', format: ms },
  makeup: { label: 'Makeup', min: 0, max: 24, default: 0, curve: 'linear', format: db },
} satisfies Record<keyof CompressorParams, NumericParamSpec>;

export const DELAY_SPECS = {
  time: { label: 'Time', min: 0.01, max: 2, default: 0.375, curve: 'exp', format: ms },
  feedback: { label: 'Feedback', min: 0, max: 0.95, default: 0.35, curve: 'linear', format: pct },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.3, curve: 'linear', format: pct },
} satisfies Record<'time' | 'feedback' | 'mix', NumericParamSpec>;

export const REVERB_SPECS = {
  decay: { label: 'Decay', min: 0.2, max: 10, default: 2.2, curve: 'exp', format: ms },
  preDelay: { label: 'Pre-Dly', min: 0, max: 0.25, default: 0.02, curve: 'linear', format: ms },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.25, curve: 'linear', format: pct },
} satisfies Record<keyof ReverbParams, NumericParamSpec>;

export const CHORUS_SPECS = {
  rate: { label: 'Rate', min: 0.02, max: 10, default: 0.8, curve: 'exp', format: (v) => `${v.toFixed(2)} Hz` },
  depth: { label: 'Depth', min: 0, max: 0.01, default: 0.003, curve: 'linear', format: (v) => `${(v * 1000).toFixed(1)} ms` },
  delay: { label: 'Delay', min: 0.0003, max: 0.03, default: 0.012, curve: 'exp', format: (v) => `${(v * 1000).toFixed(1)} ms` },
  feedback: { label: 'Feedback', min: -0.95, max: 0.95, default: 0, curve: 'linear', bipolar: true, format: (v) => `${Math.round(v * 100)}%` },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'linear', format: pct },
  width: { label: 'Width', min: 0, max: 1, default: 0.5, curve: 'linear', format: (v) => `${Math.round(v * 180)}°` },
} satisfies Record<keyof ChorusParams, NumericParamSpec>;

// ---------------------------------------------------------------------------
// Spectra EQ (parametric, 8 bands)
// ---------------------------------------------------------------------------

export const PEQ_BANDS = 8;
export const PEQ_TYPES: PeqBandType[] = ['bell', 'lowshelf', 'highshelf', 'lowcut', 'highcut', 'notch', 'bandpass'];
export const PEQ_TYPE_LABELS: Record<PeqBandType, string> = {
  bell: 'Bell',
  lowshelf: 'Low Shelf',
  highshelf: 'High Shelf',
  lowcut: 'Low Cut',
  highcut: 'High Cut',
  notch: 'Notch',
  bandpass: 'Band Pass',
};
export const PEQ_SLOPES: PeqSlope[] = [12, 24, 48];
export const PEQ_BAND_COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];

export const PEQ_SPECS = {
  freq: { label: 'Freq', min: 20, max: 20000, default: 1000, curve: 'exp', format: hz },
  gain: { label: 'Gain', min: -24, max: 24, default: 0, curve: 'linear', bipolar: true, format: db },
  q: { label: 'Q', min: 0.1, max: 18, default: 1, curve: 'exp', format: (v) => v.toFixed(2) },
  output: { label: 'Output', min: -24, max: 24, default: 0, curve: 'linear', bipolar: true, format: db },
} satisfies Record<'freq' | 'gain' | 'q' | 'output', NumericParamSpec>;

/** Band types whose gain parameter does anything. */
export function peqHasGain(t: PeqBandType): boolean {
  return t === 'bell' || t === 'lowshelf' || t === 'highshelf';
}
/** Band types whose Q parameter does anything (Web Audio shelves have no Q). */
export function peqHasQ(t: PeqBandType, slope: PeqSlope): boolean {
  if (t === 'lowshelf' || t === 'highshelf') return false;
  if ((t === 'lowcut' || t === 'highcut') && slope !== 12) return false;
  return true;
}

const PEQ_DEFAULT_FREQS = [40, 120, 300, 800, 2000, 5000, 10000, 16000];

export function defaultPeqBand(i: number, overrides: Partial<PeqBand> = {}): PeqBand {
  return { enabled: false, type: 'bell', freq: PEQ_DEFAULT_FREQS[i] ?? 1000, gain: 0, q: 1, slope: 24, ...overrides };
}

export function defaultPeqParams(): PeqParams {
  return { bands: Array.from({ length: PEQ_BANDS }, (_, i) => defaultPeqBand(i)), output: 0 };
}

function peqPreset(bands: Partial<PeqBand>[], output = 0): PeqParams {
  const p = defaultPeqParams();
  bands.forEach((b, i) => (p.bands[i] = defaultPeqBand(i, { enabled: true, ...b })));
  return { ...p, output };
}

/** Tempo-sync divisions in quarter notes. */
export const DELAY_DIVISIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '1/16' },
  { value: 1 / 3, label: '1/8T' },
  { value: 0.5, label: '1/8' },
  { value: 0.75, label: '1/8 D' },
  { value: 2 / 3, label: '1/4T' },
  { value: 1, label: '1/4' },
  { value: 1.5, label: '1/4 D' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1 bar' },
];

export const MAX_DELAY_SECONDS = 4;

/** Effective delay time in seconds (synced divisions follow the tempo). */
export function delayTimeSeconds(p: DelayParams, bpm: number): number {
  const t = p.sync ? (p.division * 60) / bpm : p.time;
  return Math.min(MAX_DELAY_SECONDS, Math.max(0.001, t));
}

/** Equal-power dry/wet gains. */
export function mixGains(mix: number): { dry: number; wet: number } {
  const m = Math.min(1, Math.max(0, mix));
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}

export function defaultParams(type: 'eq'): EqParams;
export function defaultParams(type: 'peq'): PeqParams;
export function defaultParams(type: 'compressor'): CompressorParams;
export function defaultParams(type: 'delay'): DelayParams;
export function defaultParams(type: 'reverb'): ReverbParams;
export function defaultParams(type: 'chorus'): ChorusParams;
export function defaultParams(type: EffectType): EffectSlot['params'];
export function defaultParams(type: EffectType): EffectSlot['params'] {
  switch (type) {
    case 'eq':
      return { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1000 };
    case 'peq':
      return defaultPeqParams();
    case 'compressor':
      return { threshold: -18, ratio: 4, attack: 0.01, release: 0.15, makeup: 0 };
    case 'delay':
      return { time: 0.375, feedback: 0.35, mix: 0.3, sync: true, division: 0.75 };
    case 'reverb':
      return { decay: 2.2, preDelay: 0.02, mix: 0.25 };
    case 'chorus':
      return { rate: 0.8, depth: 0.003, delay: 0.012, feedback: 0, mix: 0.5, width: 0.5 };
  }
}

export function createEffectSlot(type: EffectType): EffectSlot {
  const id = createId('fx');
  switch (type) {
    case 'eq':
      return { id, type, enabled: true, params: defaultParams('eq') };
    case 'peq':
      return { id, type, enabled: true, params: defaultParams('peq') };
    case 'compressor':
      return { id, type, enabled: true, params: defaultParams('compressor') };
    case 'delay':
      return { id, type, enabled: true, params: defaultParams('delay') };
    case 'reverb':
      return { id, type, enabled: true, params: defaultParams('reverb') };
    case 'chorus':
      return { id, type, enabled: true, params: defaultParams('chorus') };
  }
}

function clampSpec(spec: NumericParamSpec, v: unknown): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : spec.default;
  return Math.min(spec.max, Math.max(spec.min, x));
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Validate an untrusted effect slot (from a project file). Returns null if unusable. */
export function sanitizeEffect(input: unknown): EffectSlot | null {
  const s = rec(input);
  const id = typeof s.id === 'string' && s.id ? s.id : createId('fx');
  const enabled = s.enabled !== false;
  const p = rec(s.params);
  switch (s.type) {
    case 'eq':
      return {
        id,
        enabled,
        type: 'eq',
        params: {
          lowGain: clampSpec(EQ_SPECS.lowGain, p.lowGain),
          midGain: clampSpec(EQ_SPECS.midGain, p.midGain),
          highGain: clampSpec(EQ_SPECS.highGain, p.highGain),
          midFreq: clampSpec(EQ_SPECS.midFreq, p.midFreq),
        },
      };
    case 'peq': {
      const bandsIn = Array.isArray(p.bands) ? p.bands : [];
      const bands = Array.from({ length: PEQ_BANDS }, (_, i) => {
        const b = rec(bandsIn[i]);
        const type = PEQ_TYPES.includes(b.type as PeqBandType) ? (b.type as PeqBandType) : 'bell';
        const slope = PEQ_SLOPES.includes(b.slope as PeqSlope) ? (b.slope as PeqSlope) : 24;
        return {
          enabled: b.enabled === true,
          type,
          freq: clampSpec(PEQ_SPECS.freq, b.freq ?? PEQ_DEFAULT_FREQS[i]),
          gain: clampSpec(PEQ_SPECS.gain, b.gain),
          q: clampSpec(PEQ_SPECS.q, b.q),
          slope,
        } satisfies PeqBand;
      });
      return { id, enabled, type: 'peq', params: { bands, output: clampSpec(PEQ_SPECS.output, p.output) } };
    }
    case 'compressor':
      return {
        id,
        enabled,
        type: 'compressor',
        params: {
          threshold: clampSpec(COMP_SPECS.threshold, p.threshold),
          ratio: clampSpec(COMP_SPECS.ratio, p.ratio),
          attack: clampSpec(COMP_SPECS.attack, p.attack),
          release: clampSpec(COMP_SPECS.release, p.release),
          makeup: clampSpec(COMP_SPECS.makeup, p.makeup),
        },
      };
    case 'delay': {
      const div = typeof p.division === 'number' && DELAY_DIVISIONS.some((d) => Math.abs(d.value - (p.division as number)) < 1e-6) ? p.division : 0.75;
      return {
        id,
        enabled,
        type: 'delay',
        params: {
          time: clampSpec(DELAY_SPECS.time, p.time),
          feedback: clampSpec(DELAY_SPECS.feedback, p.feedback),
          mix: clampSpec(DELAY_SPECS.mix, p.mix),
          sync: p.sync !== false,
          division: div,
        },
      };
    }
    case 'chorus':
      return {
        id,
        enabled,
        type: 'chorus',
        params: {
          rate: clampSpec(CHORUS_SPECS.rate, p.rate),
          depth: clampSpec(CHORUS_SPECS.depth, p.depth),
          delay: clampSpec(CHORUS_SPECS.delay, p.delay),
          feedback: clampSpec(CHORUS_SPECS.feedback, p.feedback),
          mix: clampSpec(CHORUS_SPECS.mix, p.mix),
          width: clampSpec(CHORUS_SPECS.width, p.width),
        },
      };
    case 'reverb':
      return {
        id,
        enabled,
        type: 'reverb',
        params: {
          decay: clampSpec(REVERB_SPECS.decay, p.decay),
          preDelay: clampSpec(REVERB_SPECS.preDelay, p.preDelay),
          mix: clampSpec(REVERB_SPECS.mix, p.mix),
        },
      };
    default:
      return null;
  }
}

/** How long an effect keeps sounding after its input goes silent (for export tails). */
export function effectTailSeconds(slot: EffectSlot, bpm: number): number {
  if (!slot.enabled) return 0;
  switch (slot.type) {
    case 'delay': {
      const t = delayTimeSeconds(slot.params, bpm);
      const fb = slot.params.feedback;
      if (fb <= 0.001) return t;
      // repeats until the echo falls below -60 dB
      return Math.min(30, t * (1 + Math.log(0.001) / Math.log(fb)));
    }
    case 'reverb':
      return slot.params.preDelay + slot.params.decay + 0.05;
    case 'compressor':
      return slot.params.release;
    case 'chorus': {
      const fb = Math.abs(slot.params.feedback);
      const d = slot.params.delay + slot.params.depth;
      return fb < 0.01 ? d : Math.min(10, d * (1 + Math.log(0.001) / Math.log(fb)));
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface EffectPreset<T extends EffectType = EffectType> {
  name: string;
  type: T;
  factory: boolean;
  params: EffectSlot['params'];
}

export const FACTORY_EFFECT_PRESETS: EffectPreset[] = [
  { name: 'Flat', type: 'eq', factory: true, params: defaultParams('eq') },
  { name: 'Bass Boost', type: 'eq', factory: true, params: { lowGain: 6, midGain: -1.5, highGain: 0, midFreq: 450 } },
  { name: 'Air', type: 'eq', factory: true, params: { lowGain: -2, midGain: 0, highGain: 5, midFreq: 2500 } },
  { name: 'Telephone', type: 'eq', factory: true, params: { lowGain: -18, midGain: 9, highGain: -18, midFreq: 1500 } },
  { name: 'Clean (empty)', type: 'peq', factory: true, params: defaultPeqParams() },
  { name: 'Rumble Cut', type: 'peq', factory: true, params: peqPreset([{ type: 'lowcut', freq: 80, slope: 24 }]) },
  {
    name: 'Vocal Presence',
    type: 'peq',
    factory: true,
    params: peqPreset([
      { type: 'lowcut', freq: 100, slope: 24 },
      { type: 'bell', freq: 300, gain: -2.5, q: 1.2 },
      { type: 'bell', freq: 3200, gain: 3, q: 0.8 },
      { type: 'highshelf', freq: 10000, gain: 2.5 },
    ]),
  },
  {
    name: 'Kick Punch',
    type: 'peq',
    factory: true,
    params: peqPreset([
      { type: 'lowcut', freq: 30, slope: 48 },
      { type: 'bell', freq: 60, gain: 4, q: 1.4 },
      { type: 'bell', freq: 350, gain: -5, q: 1.8 },
      { type: 'bell', freq: 4000, gain: 3, q: 1.2 },
    ]),
  },
  {
    name: 'Lo-Fi Radio',
    type: 'peq',
    factory: true,
    params: peqPreset([
      { type: 'lowcut', freq: 450, slope: 48 },
      { type: 'highcut', freq: 3200, slope: 48 },
      { type: 'bell', freq: 1400, gain: 5, q: 1.5 },
    ]),
  },
  { name: 'Hum Notch 50 Hz', type: 'peq', factory: true, params: peqPreset([{ type: 'notch', freq: 50, q: 8 }, { type: 'notch', freq: 100, q: 8 }]) },
  { name: 'Chorus', type: 'chorus', factory: true, params: { rate: 0.8, depth: 0.003, delay: 0.012, feedback: 0, mix: 0.5, width: 0.5 } },
  { name: 'Wide Chorus', type: 'chorus', factory: true, params: { rate: 0.35, depth: 0.0045, delay: 0.018, feedback: 0.1, mix: 0.55, width: 1 } },
  { name: 'Flanger', type: 'chorus', factory: true, params: { rate: 0.25, depth: 0.0018, delay: 0.002, feedback: 0.7, mix: 0.5, width: 0.25 } },
  { name: 'Jet Flanger', type: 'chorus', factory: true, params: { rate: 0.12, depth: 0.0024, delay: 0.0026, feedback: -0.85, mix: 0.5, width: 0.1 } },
  { name: 'Vibrato', type: 'chorus', factory: true, params: { rate: 5.5, depth: 0.0018, delay: 0.004, feedback: 0, mix: 1, width: 0 } },
  { name: 'Gentle Glue', type: 'compressor', factory: true, params: { threshold: -14, ratio: 2, attack: 0.03, release: 0.25, makeup: 2 } },
  { name: 'Punchy Drums', type: 'compressor', factory: true, params: { threshold: -22, ratio: 5, attack: 0.012, release: 0.09, makeup: 6 } },
  { name: 'Squash', type: 'compressor', factory: true, params: { threshold: -36, ratio: 14, attack: 0.002, release: 0.2, makeup: 12 } },
  { name: 'Dotted Eighth', type: 'delay', factory: true, params: { time: 0.375, feedback: 0.4, mix: 0.3, sync: true, division: 0.75 } },
  { name: 'Slapback', type: 'delay', factory: true, params: { time: 0.09, feedback: 0.1, mix: 0.3, sync: false, division: 0.25 } },
  { name: 'Quarter Echo', type: 'delay', factory: true, params: { time: 0.5, feedback: 0.55, mix: 0.35, sync: true, division: 1 } },
  { name: 'Small Room', type: 'reverb', factory: true, params: { decay: 0.7, preDelay: 0.008, mix: 0.2 } },
  { name: 'Hall', type: 'reverb', factory: true, params: { decay: 3.2, preDelay: 0.03, mix: 0.3 } },
  { name: 'Ambient Wash', type: 'reverb', factory: true, params: { decay: 8, preDelay: 0.06, mix: 0.5 } },
];

const USER_FX_KEY = 'phasr.fx.userPresets.v1';

export function loadUserEffectPresets(): EffectPreset[] {
  try {
    const raw = globalThis.localStorage?.getItem(USER_FX_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: EffectPreset[] = [];
    for (const item of arr) {
      const r = rec(item);
      const slot = sanitizeEffect({ type: r.type, params: r.params });
      if (slot && typeof r.name === 'string') out.push({ name: r.name, type: slot.type, factory: false, params: slot.params });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserEffectPresets(presets: EffectPreset[]): boolean {
  try {
    globalThis.localStorage?.setItem(USER_FX_KEY, JSON.stringify(presets.filter((p) => !p.factory)));
    return true;
  } catch {
    return false;
  }
}
