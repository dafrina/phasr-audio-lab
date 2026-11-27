/**
 * Insert effect definitions: parameter specs (ranges/defaults/formatting),
 * factory presets, validation and tail-length estimates. Pure module — no
 * Web Audio here, so it is shared by UI, engine, persistence and tests.
 */
import { createId } from '../../core/ids';
import type {
  CompressorParams,
  LimiterParams,
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
  RoomParams,
  SaturatorMode,
  SaturatorParams,
  UtilityParams,
  AutoFilterParams,
  AutoFilterMode,
  PhaserParams,
  LfoShape,
} from '../../project/types';
import type { NumericParamSpec } from '../../synth/params';

export const EFFECT_TYPES: EffectType[] = ['utility', 'eq', 'peq', 'compressor', 'limiter', 'saturator', 'autofilter', 'delay', 'chorus', 'phaser', 'room', 'reverb'];

export const EFFECT_LABELS: Record<EffectType, string> = {
  eq: 'EQ-3',
  peq: 'Spectra EQ',
  chorus: 'Chorus / Flanger',
  autofilter: 'Auto-Filter',
  phaser: 'Phaser',
  compressor: 'Compressor',
  limiter: 'Limiter',
  saturator: 'Saturator',
  utility: 'Utility',
  delay: 'Delay',
  reverb: 'Reverb Pro',
  room: 'Reverb Lite',
};

/** One line on what each effect is (the add-effect menu and device headers). */
export const EFFECT_BLURBS: Partial<Record<EffectType, string>> = {
  reverb: 'Convolution reverb: a dense, natural room rendered from a generated impulse response, with room size, damping, early reflections, tail EQ and width — the rich one, heavier on CPU (grows with decay)',
  room: 'Algorithmic room (feedback delay network): light on CPU at any decay, decay and tone can be automated and sidechained',
  utility: 'Gain, balance, stereo width (mono … extra wide) and polarity: gain staging anywhere in a chain, nearly free',
  limiter: 'Lookahead brickwall limiter: drive the level up, no sample ever passes the ceiling; the gain ramps down before a peak arrives (the audio is delayed by the lookahead)',
  saturator: 'Drive into a waveshaper (tape, tube, overdrive, hard clip, wave folder) for warmth, grit or fuzz; auto gain keeps the level',
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

export const LIMITER_SPECS = {
  drive: { label: 'Drive', min: 0, max: 24, default: 0, curve: 'linear', format: db },
  ceiling: { label: 'Ceiling', min: -24, max: 0, default: -1, step: 0.1, curve: 'linear', format: db },
  release: { label: 'Release', min: 0.005, max: 1, default: 0.1, curve: 'exp', format: ms },
} satisfies Record<Exclude<keyof LimiterParams, 'lookahead'>, NumericParamSpec>;

/** Lookahead choices (ms): longer = a gentler attack ramp (less distortion on bass), more delay. */
export const LIMITER_LOOKAHEADS: { value: number; label: string }[] = [
  { value: 1.5, label: '1.5 ms' },
  { value: 3, label: '3 ms' },
  { value: 6, label: '6 ms' },
];

export const DELAY_SPECS = {
  time: { label: 'Time', min: 0.01, max: 2, default: 0.375, curve: 'exp', format: ms },
  feedback: { label: 'Feedback', min: 0, max: 0.95, default: 0.35, curve: 'linear', format: pct },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.3, curve: 'linear', format: pct },
} satisfies Record<'time' | 'feedback' | 'mix', NumericParamSpec>;

export const REVERB_SPECS = {
  decay: { label: 'Decay', min: 0.2, max: 10, default: 2.2, curve: 'exp', format: ms },
  preDelay: { label: 'Pre-Dly', min: 0, max: 0.25, default: 0.02, curve: 'linear', format: ms },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.25, curve: 'linear', format: pct },
  size: { label: 'Size', min: 0.3, max: 2.5, default: 1, curve: 'exp', format: (v) => `${Math.round(v * 100)}%` },
  damping: { label: 'Damping', min: 0, max: 1, default: 0.5, curve: 'linear', format: (v) => (v < 0.3 ? 'bright ' : v > 0.7 ? 'dark ' : '') + pct(v) },
  early: { label: 'Early', min: 0, max: 2, default: 1, curve: 'linear', format: pct },
  lowCut: { label: 'Low Cut', min: 20, max: 1000, default: 20, curve: 'exp', format: (v) => (v <= 20.5 ? 'off' : hz(v)) },
  highCut: { label: 'High Cut', min: 1000, max: 20000, default: 20000, curve: 'exp', format: (v) => (v >= 19900 ? 'off' : hz(v)) },
  width: { label: 'Width', min: 0, max: 1.5, default: 1, curve: 'linear', format: (v) => (v < 0.005 ? 'mono' : pct(v)) },
} satisfies Record<keyof ReverbParams, NumericParamSpec>;

export const SATURATOR_SPECS = {
  drive: { label: 'Drive', min: 0, max: 36, default: 6, curve: 'linear', format: (v) => `+${v.toFixed(1)} dB` },
  bias: { label: 'Bias', min: 0, max: 1, default: 0, curve: 'linear', format: (v) => (v < 0.005 ? 'centred' : pct(v)) },
  clean: { label: 'Clean <', min: 20, max: 500, default: 20, curve: 'exp', format: (v) => (v <= 20.5 ? 'off' : `< ${Math.round(v)} Hz`) },
  focus: { label: 'Focus', min: 200, max: 6000, default: 1200, curve: 'exp', format: hz },
  emph: { label: 'Emph', min: 0, max: 15, default: 0, curve: 'linear', format: (v) => (v < 0.05 ? 'off' : `+${v.toFixed(1)} dB`) },
  bits: { label: 'Bits', min: 1, max: 16, default: 16, curve: 'linear', format: (v) => (v >= 15.95 ? 'off' : `${v.toFixed(1)} bit`) },
  rate: { label: 'Rate', min: 500, max: 40000, default: 40000, curve: 'exp', format: (v) => (v >= 39900 ? 'off' : hz(v)) },
  tone: { label: 'Tone', min: 1000, max: 20000, default: 20000, curve: 'exp', format: (v) => (v >= 19900 ? 'open' : hz(v)) },
  output: { label: 'Output', min: -24, max: 12, default: 0, curve: 'linear', bipolar: true, format: db },
  mix: { label: 'Mix', min: 0, max: 1, default: 1, curve: 'linear', format: pct },
} satisfies Record<'drive' | 'bias' | 'clean' | 'focus' | 'emph' | 'bits' | 'rate' | 'tone' | 'output' | 'mix', NumericParamSpec>;

/** the Lo-Fi stage only runs (and costs anything) while it changes the sound */
export function saturatorCrushOn(p: Pick<SaturatorParams, 'bits' | 'rate'>): boolean {
  return p.bits < 15.95 || p.rate < 39900;
}

export const UTILITY_SPECS = {
  gain: { label: 'Gain', min: -48, max: 24, default: 0, curve: 'linear', bipolar: true, format: db },
  pan: { label: 'Balance', min: -1, max: 1, default: 0, curve: 'linear', bipolar: true, format: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) },
  width: { label: 'Width', min: 0, max: 2, default: 1, curve: 'linear', format: (v) => (v < 0.005 ? 'mono' : `${Math.round(v * 100)}%`) },
} satisfies Record<'gain' | 'pan' | 'width', NumericParamSpec>;

export const SATURATOR_MODES: { value: SaturatorMode; label: string; title: string }[] = [
  { value: 'tape', label: 'Tape', title: 'Soft and smooth (odd harmonics): glue, warmth on buses and drums' },
  { value: 'tube', label: 'Tube', title: 'Asymmetric (even harmonics): thick, warm mids — bass, vocals, keys' },
  { value: 'overdrive', label: 'Crunch', title: 'Harder knee with bite: guitars, leads, aggressive bass' },
  { value: 'hard', label: 'Clip', title: 'Hard digital clip: loud, bright, buzzy — 808s and drums' },
  { value: 'fuzz', label: 'Fuzz', title: 'High gain, lopsided clipping: buzzy, sputtering fuzz — leads, bass, drums gone wild' },
  { value: 'rectify', label: 'Rect', title: 'Rectifier: flips the negative half up — an octave above and ring-mod grit' },
  { value: 'fold', label: 'Fold', title: 'Wave folder: folds the wave back past full scale — metallic synth tones' },
];

export const ROOM_SPECS = {
  decay: { label: 'Decay', min: 0.2, max: 12, default: 1.6, curve: 'exp', format: (v) => (v < 10 ? `${v.toFixed(2)} s` : `${v.toFixed(1)} s`) },
  size: { label: 'Size', min: 0.4, max: 1.6, default: 1, curve: 'linear', format: (v) => (v < 0.7 ? 'Booth' : v < 1 ? 'Room' : v < 1.3 ? 'Hall' : 'Cathedral') + ` ${Math.round(v * 100)}%` },
  tone: { label: 'Tone', min: 800, max: 16000, default: 6000, curve: 'exp', format: hz },
  preDelay: { label: 'Pre-Dly', min: 0, max: 0.25, default: 0.012, curve: 'linear', format: ms },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.25, curve: 'linear', format: pct },
} satisfies Record<keyof RoomParams, NumericParamSpec>;

export const CHORUS_SPECS = {
  rate: { label: 'Rate', min: 0.02, max: 10, default: 0.8, curve: 'exp', format: (v) => `${v.toFixed(2)} Hz` },
  depth: { label: 'Depth', min: 0, max: 0.01, default: 0.003, curve: 'linear', format: (v) => `${(v * 1000).toFixed(1)} ms` },
  delay: { label: 'Delay', min: 0.0003, max: 0.03, default: 0.012, curve: 'exp', format: (v) => `${(v * 1000).toFixed(1)} ms` },
  feedback: { label: 'Feedback', min: -0.95, max: 0.95, default: 0, curve: 'linear', bipolar: true, format: (v) => `${Math.round(v * 100)}%` },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'linear', format: pct },
  width: { label: 'Width', min: 0, max: 1, default: 0.5, curve: 'linear', format: (v) => `${Math.round(v * 180)}°` },
} satisfies Record<keyof ChorusParams, NumericParamSpec>;

export const AUTOFILTER_SPECS = {
  cutoff: { label: 'Cutoff', min: 30, max: 18000, default: 900, curve: 'exp', format: hz },
  reso: { label: 'Reso', min: 0, max: 1, default: 0.35, curve: 'linear', format: pct },
  lfoDepth: { label: 'LFO Amt', min: 0, max: 4, default: 0, curve: 'linear', format: (v) => (v < 0.01 ? 'off' : `±${v.toFixed(1)} oct`) },
  rate: { label: 'Rate', min: 0.05, max: 20, default: 1, curve: 'exp', format: (v) => `${v.toFixed(2)} Hz` },
  mix: { label: 'Mix', min: 0, max: 1, default: 1, curve: 'linear', format: pct },
} satisfies Record<'cutoff' | 'reso' | 'lfoDepth' | 'rate' | 'mix', NumericParamSpec>;
export const AUTOFILTER_MODES: { value: AutoFilterMode; label: string }[] = [
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'highpass', label: 'High-pass' },
  { value: 'bandpass', label: 'Band-pass' },
];
export const LFO_SHAPES: { value: LfoShape; label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Saw' },
];
/** LFO periods in beats */
export const LFO_DIVISIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '1/16' },
  { value: 0.5, label: '1/8' },
  { value: 1, label: '1/4' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1 bar' },
  { value: 8, label: '2 bars' },
  { value: 16, label: '4 bars' },
  { value: 32, label: '8 bars' },
];
export const PHASER_SPECS = {
  center: { label: 'Center', min: 100, max: 6000, default: 700, curve: 'exp', format: hz },
  depth: { label: 'Depth', min: 0, max: 4, default: 2, curve: 'linear', format: (v) => `±${v.toFixed(1)} oct` },
  feedback: { label: 'Feedback', min: -0.9, max: 0.9, default: 0.5, curve: 'linear', bipolar: true, format: (v) => `${Math.round(v * 100)}%` },
  rate: { label: 'Rate', min: 0.02, max: 10, default: 0.3, curve: 'exp', format: (v) => `${v.toFixed(2)} Hz` },
  stereo: { label: 'Stereo', min: 0, max: 1, default: 0.5, curve: 'linear', format: (v) => `${Math.round(v * 180)}°` },
  mix: { label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'linear', format: pct },
} satisfies Record<'center' | 'depth' | 'feedback' | 'rate' | 'stereo' | 'mix', NumericParamSpec>;
export const PHASER_STAGE_CHOICES = [2, 4, 6, 8, 12];
export function phaserLfoHz(p: PhaserParams, bpm: number): number {
  return p.sync ? bpm / 60 / Math.max(0.0625, p.division) : p.rate;
}

/** LFO frequency in Hz (synced periods follow the tempo). */
export function autoFilterLfoHz(p: AutoFilterParams, bpm: number): number {
  return p.sync ? bpm / 60 / Math.max(0.0625, p.division) : p.rate;
}

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
export function defaultParams(type: 'limiter'): LimiterParams;
export function defaultParams(type: 'delay'): DelayParams;
export function defaultParams(type: 'reverb'): ReverbParams;
export function defaultParams(type: 'room'): RoomParams;
export function defaultParams(type: 'saturator'): SaturatorParams;
export function defaultParams(type: 'utility'): UtilityParams;
export function defaultParams(type: 'chorus'): ChorusParams;
export function defaultParams(type: 'autofilter'): AutoFilterParams;
export function defaultParams(type: 'phaser'): PhaserParams;
export function defaultParams(type: EffectType): EffectSlot['params'];
export function defaultParams(type: EffectType): EffectSlot['params'] {
  switch (type) {
    case 'eq':
      return { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1000 };
    case 'peq':
      return defaultPeqParams();
    case 'compressor':
      return { threshold: -18, ratio: 4, attack: 0.01, release: 0.15, makeup: 0 };
    case 'limiter':
      return { drive: 0, ceiling: -1, release: 0.1, lookahead: 3 };
    case 'delay':
      return { time: 0.375, feedback: 0.35, mix: 0.3, sync: true, division: 0.75 };
    case 'reverb':
      return { decay: 2.2, preDelay: 0.02, mix: 0.25, size: 1, damping: 0.5, early: 1, lowCut: 20, highCut: 20000, width: 1 };
    case 'room':
      return { decay: 1.6, size: 1, tone: 6000, preDelay: 0.012, mix: 0.25 };
    case 'utility':
      return { gain: 0, pan: 0, width: 1, invertL: false, invertR: false };
    case 'saturator':
      return { mode: 'tape', drive: 6, bias: 0, clean: 20, focus: 1200, emph: 0, bits: 16, rate: 40000, tone: 20000, output: 0, mix: 1, autoGain: true };
    case 'chorus':
      return { rate: 0.8, depth: 0.003, delay: 0.012, feedback: 0, mix: 0.5, width: 0.5 };
    case 'autofilter':
      return { mode: 'lowpass', cutoff: 900, reso: 0.35, lfoDepth: 0, shape: 'sine', sync: true, division: 4, rate: 1, mix: 1 };
    case 'phaser':
      return { stages: 6, center: 700, depth: 2, feedback: 0.5, sync: true, division: 8, rate: 0.3, stereo: 0.5, mix: 0.5 };
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
    case 'limiter':
      return { id, type, enabled: true, params: defaultParams('limiter') };
    case 'delay':
      return { id, type, enabled: true, params: defaultParams('delay') };
    case 'reverb':
      return { id, type, enabled: true, params: defaultParams('reverb') };
    case 'room':
      return { id, type, enabled: true, params: defaultParams('room') };
    case 'saturator':
      return { id, type, enabled: true, params: defaultParams('saturator') };
    case 'utility':
      return { id, type, enabled: true, params: defaultParams('utility') };
    case 'chorus':
      return { id, type, enabled: true, params: defaultParams('chorus') };
    case 'autofilter':
      return { id, type, enabled: true, params: defaultParams('autofilter') };
    case 'phaser':
      return { id, type, enabled: true, params: defaultParams('phaser') };
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
    case 'limiter': {
      const la = typeof p.lookahead === 'number' && Number.isFinite(p.lookahead) ? p.lookahead : 3;
      const near = LIMITER_LOOKAHEADS.reduce((a, b) => (Math.abs(b.value - la) < Math.abs(a.value - la) ? b : a));
      return {
        id,
        enabled,
        type: 'limiter',
        params: {
          drive: clampSpec(LIMITER_SPECS.drive, p.drive),
          ceiling: clampSpec(LIMITER_SPECS.ceiling, p.ceiling),
          release: clampSpec(LIMITER_SPECS.release, p.release),
          lookahead: near.value,
        },
      };
    }
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
    case 'autofilter': {
      const d = defaultParams('autofilter');
      return {
        id,
        enabled,
        type: 'autofilter',
        params: {
          mode: AUTOFILTER_MODES.some((m) => m.value === p.mode) ? (p.mode as AutoFilterMode) : d.mode,
          cutoff: clampSpec(AUTOFILTER_SPECS.cutoff, p.cutoff),
          reso: clampSpec(AUTOFILTER_SPECS.reso, p.reso),
          lfoDepth: clampSpec(AUTOFILTER_SPECS.lfoDepth, p.lfoDepth),
          shape: LFO_SHAPES.some((s) => s.value === p.shape) ? (p.shape as LfoShape) : d.shape,
          sync: p.sync !== false,
          division: LFO_DIVISIONS.some((x) => x.value === p.division) ? (p.division as number) : d.division,
          rate: clampSpec(AUTOFILTER_SPECS.rate, p.rate),
          mix: clampSpec(AUTOFILTER_SPECS.mix, p.mix),
        },
      };
    }
    case 'phaser': {
      const d = defaultParams('phaser');
      return {
        id,
        enabled,
        type: 'phaser',
        params: {
          stages: PHASER_STAGE_CHOICES.includes(p.stages as number) ? (p.stages as number) : d.stages,
          center: clampSpec(PHASER_SPECS.center, p.center),
          depth: clampSpec(PHASER_SPECS.depth, p.depth),
          feedback: clampSpec(PHASER_SPECS.feedback, p.feedback),
          sync: p.sync !== false,
          division: LFO_DIVISIONS.some((x) => x.value === p.division) ? (p.division as number) : d.division,
          rate: clampSpec(PHASER_SPECS.rate, p.rate),
          stereo: clampSpec(PHASER_SPECS.stereo, p.stereo),
          mix: clampSpec(PHASER_SPECS.mix, p.mix),
        },
      };
    }
    case 'reverb':
      return {
        id,
        enabled,
        type: 'reverb',
        params: {
          decay: clampSpec(REVERB_SPECS.decay, p.decay),
          preDelay: clampSpec(REVERB_SPECS.preDelay, p.preDelay),
          mix: clampSpec(REVERB_SPECS.mix, p.mix),
          size: clampSpec(REVERB_SPECS.size, p.size),
          damping: clampSpec(REVERB_SPECS.damping, p.damping),
          early: clampSpec(REVERB_SPECS.early, p.early),
          lowCut: clampSpec(REVERB_SPECS.lowCut, p.lowCut),
          highCut: clampSpec(REVERB_SPECS.highCut, p.highCut),
          width: clampSpec(REVERB_SPECS.width, p.width),
        },
      };
    case 'utility':
      return {
        id,
        enabled,
        type: 'utility',
        params: {
          gain: clampSpec(UTILITY_SPECS.gain, p.gain),
          pan: clampSpec(UTILITY_SPECS.pan, p.pan),
          width: clampSpec(UTILITY_SPECS.width, p.width),
          invertL: p.invertL === true,
          invertR: p.invertR === true,
        },
      };
    case 'saturator':
      return {
        id,
        enabled,
        type: 'saturator',
        params: {
          mode: SATURATOR_MODES.some((m) => m.value === p.mode) ? (p.mode as SaturatorMode) : 'tape',
          drive: clampSpec(SATURATOR_SPECS.drive, p.drive),
          bias: clampSpec(SATURATOR_SPECS.bias, p.bias),
          clean: clampSpec(SATURATOR_SPECS.clean, p.clean),
          focus: clampSpec(SATURATOR_SPECS.focus, p.focus),
          emph: clampSpec(SATURATOR_SPECS.emph, p.emph),
          bits: clampSpec(SATURATOR_SPECS.bits, p.bits),
          rate: clampSpec(SATURATOR_SPECS.rate, p.rate),
          tone: clampSpec(SATURATOR_SPECS.tone, p.tone),
          output: clampSpec(SATURATOR_SPECS.output, p.output),
          mix: clampSpec(SATURATOR_SPECS.mix, p.mix),
          autoGain: p.autoGain !== false,
        },
      };
    case 'room':
      return {
        id,
        enabled,
        type: 'room',
        params: {
          decay: clampSpec(ROOM_SPECS.decay, p.decay),
          size: clampSpec(ROOM_SPECS.size, p.size),
          tone: clampSpec(ROOM_SPECS.tone, p.tone),
          preDelay: clampSpec(ROOM_SPECS.preDelay, p.preDelay),
          mix: clampSpec(ROOM_SPECS.mix, p.mix),
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
    case 'room':
      return slot.params.preDelay + slot.params.decay + 0.05;
    case 'compressor':
      return slot.params.release;
    case 'limiter':
      return slot.params.lookahead / 1000; // the delay; the release only changes the level
    case 'phaser':
      return 0.05 + Math.abs(slot.params.feedback) * 0.2;
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
  { name: 'Init', type: 'autofilter', factory: true, params: defaultParams('autofilter') },
  { name: 'House Sweep (2 bars)', type: 'autofilter', factory: true, params: { mode: 'lowpass', cutoff: 1200, reso: 0.55, lfoDepth: 2.5, shape: 'sine', sync: true, division: 8, rate: 1, mix: 1 } },
  { name: 'Wobble 1/8', type: 'autofilter', factory: true, params: { mode: 'lowpass', cutoff: 500, reso: 0.7, lfoDepth: 2, shape: 'sine', sync: true, division: 0.5, rate: 1, mix: 1 } },
  { name: 'Choppy Gate 1/16', type: 'autofilter', factory: true, params: { mode: 'lowpass', cutoff: 2500, reso: 0.2, lfoDepth: 3, shape: 'square', sync: true, division: 0.25, rate: 1, mix: 1 } },
  { name: 'Hi-Pass Riser', type: 'autofilter', factory: true, params: { mode: 'highpass', cutoff: 150, reso: 0.45, lfoDepth: 0, shape: 'sine', sync: true, division: 4, rate: 1, mix: 1 } },
  { name: 'Telephone Band', type: 'autofilter', factory: true, params: { mode: 'bandpass', cutoff: 1500, reso: 0.4, lfoDepth: 0, shape: 'sine', sync: true, division: 4, rate: 1, mix: 1 } },
  { name: 'Classic (6 stages)', type: 'phaser', factory: true, params: defaultParams('phaser') },
  { name: 'Hat Swirl 1/2', type: 'phaser', factory: true, params: { stages: 8, center: 2500, depth: 1.6, feedback: 0.6, sync: true, division: 2, rate: 0.3, stereo: 0.75, mix: 0.5 } },
  { name: 'Slow Jet (4 bars)', type: 'phaser', factory: true, params: { stages: 12, center: 900, depth: 2.6, feedback: 0.75, sync: true, division: 16, rate: 0.3, stereo: 0.5, mix: 0.5 } },
  { name: 'Subtle Shimmer', type: 'phaser', factory: true, params: { stages: 4, center: 1200, depth: 1.2, feedback: 0.25, sync: false, division: 8, rate: 0.18, stereo: 1, mix: 0.35 } },
  { name: 'Funky Fast', type: 'phaser', factory: true, params: { stages: 4, center: 600, depth: 1.8, feedback: -0.6, sync: true, division: 0.5, rate: 0.3, stereo: 0.25, mix: 0.5 } },
  { name: 'Chorus', type: 'chorus', factory: true, params: { rate: 0.8, depth: 0.003, delay: 0.012, feedback: 0, mix: 0.5, width: 0.5 } },
  { name: 'Wide Chorus', type: 'chorus', factory: true, params: { rate: 0.35, depth: 0.0045, delay: 0.018, feedback: 0.1, mix: 0.55, width: 1 } },
  { name: 'Flanger', type: 'chorus', factory: true, params: { rate: 0.25, depth: 0.0018, delay: 0.002, feedback: 0.7, mix: 0.5, width: 0.25 } },
  { name: 'Jet Flanger', type: 'chorus', factory: true, params: { rate: 0.12, depth: 0.0024, delay: 0.0026, feedback: -0.85, mix: 0.5, width: 0.1 } },
  { name: 'Vibrato', type: 'chorus', factory: true, params: { rate: 5.5, depth: 0.0018, delay: 0.004, feedback: 0, mix: 1, width: 0 } },
  { name: 'Gentle Glue', type: 'compressor', factory: true, params: { threshold: -14, ratio: 2, attack: 0.03, release: 0.25, makeup: 2 } },
  { name: 'Punchy Drums', type: 'compressor', factory: true, params: { threshold: -22, ratio: 5, attack: 0.012, release: 0.09, makeup: 6 } },
  { name: 'Squash', type: 'compressor', factory: true, params: { threshold: -36, ratio: 14, attack: 0.002, release: 0.2, makeup: 12 } },
  { name: 'Master Safety', type: 'limiter', factory: true, params: { drive: 0, ceiling: -1, release: 0.1, lookahead: 3 } },
  { name: 'Loud Master', type: 'limiter', factory: true, params: { drive: 6, ceiling: -0.3, release: 0.08, lookahead: 3 } },
  { name: 'Transparent', type: 'limiter', factory: true, params: { drive: 3, ceiling: -1, release: 0.3, lookahead: 6 } },
  { name: 'Brickwall Smash', type: 'limiter', factory: true, params: { drive: 14, ceiling: -0.3, release: 0.03, lookahead: 1.5 } },
  { name: 'Drum Bus Catch', type: 'limiter', factory: true, params: { drive: 4, ceiling: -6, release: 0.04, lookahead: 1.5 } },
  { name: 'Dotted Eighth', type: 'delay', factory: true, params: { time: 0.375, feedback: 0.4, mix: 0.3, sync: true, division: 0.75 } },
  { name: 'Slapback', type: 'delay', factory: true, params: { time: 0.09, feedback: 0.1, mix: 0.3, sync: false, division: 0.25 } },
  { name: 'Quarter Echo', type: 'delay', factory: true, params: { time: 0.5, feedback: 0.55, mix: 0.35, sync: true, division: 1 } },
  { name: 'Small Room', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 0.7, preDelay: 0.008, mix: 0.2 } },
  { name: 'Hall', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 3.2, preDelay: 0.03, mix: 0.3 } },
  { name: 'Ambient Wash', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 8, preDelay: 0.06, mix: 0.5 } },
  { name: 'Concert Hall', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 2.8, preDelay: 0.035, mix: 0.28, size: 1.8, damping: 0.55, early: 0.8, lowCut: 120 } },
  { name: 'Bright Plate', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 1.8, preDelay: 0.01, mix: 0.25, size: 0.6, damping: 0.15, early: 0.3, lowCut: 200, width: 1.2 } },
  { name: 'Dark Cathedral', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 7, preDelay: 0.05, mix: 0.35, size: 2.5, damping: 0.85, early: 0.6, highCut: 7000, width: 1.3 } },
  { name: 'Vocal Room', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 1.1, preDelay: 0.025, mix: 0.2, size: 0.8, damping: 0.6, lowCut: 250, highCut: 10000 } },
  { name: 'Drum Room', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 0.6, preDelay: 0.004, mix: 0.25, size: 0.5, damping: 0.4, early: 1.6, lowCut: 150 } },
  { name: 'Mono Tail', type: 'reverb', factory: true, params: { ...defaultParams('reverb'), decay: 2, preDelay: 0.02, mix: 0.25, width: 0 } },
  { name: 'Unity', type: 'utility', factory: true, params: defaultParams('utility') },
  { name: 'Mono', type: 'utility', factory: true, params: { ...defaultParams('utility'), width: 0 } },
  { name: 'Extra Wide', type: 'utility', factory: true, params: { ...defaultParams('utility'), width: 1.6 } },
  { name: 'Trim −6 dB', type: 'utility', factory: true, params: { ...defaultParams('utility'), gain: -6 } },
  { name: 'Flip Polarity', type: 'utility', factory: true, params: { ...defaultParams('utility'), invertL: true, invertR: true } },
  { name: 'Warm Tape', type: 'saturator', factory: true, params: defaultParams('saturator') },
  { name: 'Tube Bass', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'tube', drive: 12, tone: 12000, output: 0, mix: 1, autoGain: true } },
  { name: 'Drum Bus Glue', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'tape', drive: 9, tone: 16000, output: 0, mix: 0.6, autoGain: true } },
  { name: 'Crunchy Drive', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'overdrive', drive: 20, tone: 7000, output: 0, mix: 1, autoGain: true } },
  { name: 'Loud 808', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'hard', drive: 14, tone: 9000, output: -1, mix: 1, autoGain: true } },
  { name: 'Metal Fold', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'fold', drive: 16, tone: 10000, output: 0, mix: 0.8, autoGain: true } },
  { name: 'Tight Kick Drive', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'overdrive', drive: 16, clean: 110, tone: 9000 } },
  { name: 'Guitar Pedal', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'overdrive', drive: 24, clean: 160, focus: 900, emph: 9, tone: 5500 } },
  { name: 'Velvet Fuzz', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'fuzz', drive: 22, bias: 0.2, clean: 90, tone: 6000, mix: 0.85 } },
  { name: 'Octave Up', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'rectify', drive: 6, tone: 9000, mix: 0.5 } },
  { name: 'Warm Bias Tape', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'tape', drive: 10, bias: 0.35 } },
  { name: '8-Bit', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'hard', drive: 4, bits: 8, rate: 11025, tone: 12000 } },
  { name: 'Dusty Sampler', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'tape', drive: 8, bits: 12, rate: 26000, tone: 9000 } },
  { name: 'Parallel Fuzz', type: 'saturator', factory: true, params: { ...defaultParams('saturator'), mode: 'overdrive', drive: 30, tone: 5000, output: 0, mix: 0.3, autoGain: true } },
  { name: 'Room', type: 'room', factory: true, params: defaultParams('room') },
  { name: 'Small Booth', type: 'room', factory: true, params: { decay: 0.55, size: 0.5, tone: 7500, preDelay: 0.004, mix: 0.2 } },
  { name: 'Plate', type: 'room', factory: true, params: { decay: 1.9, size: 0.8, tone: 10000, preDelay: 0.008, mix: 0.25 } },
  { name: 'Hall', type: 'room', factory: true, params: { decay: 3.2, size: 1.35, tone: 5500, preDelay: 0.03, mix: 0.28 } },
  { name: 'Dark Chamber', type: 'room', factory: true, params: { decay: 2.4, size: 1.1, tone: 2200, preDelay: 0.02, mix: 0.3 } },
  { name: 'Huge Wash', type: 'room', factory: true, params: { decay: 9, size: 1.6, tone: 4500, preDelay: 0.06, mix: 0.45 } },
  { name: 'Tight Snare Room', type: 'room', factory: true, params: { decay: 0.35, size: 0.6, tone: 9000, preDelay: 0, mix: 0.3 } },
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
