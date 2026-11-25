/**
 * TriOsc parameter model. All synth parameter names, ranges, defaults and
 * display formatting live here so the DSP, the UI and preset (de)serialization
 * agree on a single definition.
 */

export type OscWaveform = 'sine' | 'triangle' | 'saw' | 'square' | 'pulse' | 'noise';
export const OSC_WAVEFORMS: OscWaveform[] = ['sine', 'triangle', 'saw', 'square', 'pulse', 'noise'];

export type PhaseMode = 'reset' | 'random' | 'free';
export const PHASE_MODES: PhaseMode[] = ['reset', 'random', 'free'];

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';
export const FILTER_TYPES: FilterType[] = ['lowpass', 'highpass', 'bandpass'];

export type LfoWaveform = 'sine' | 'triangle' | 'square' | 'saw';
export const LFO_WAVEFORMS: LfoWaveform[] = ['sine', 'triangle', 'square', 'saw'];

export type LfoTarget = 'off' | 'pitch' | 'cutoff' | 'amp';
export const LFO_TARGETS: LfoTarget[] = ['off', 'pitch', 'cutoff', 'amp'];

export type VoiceMode = 'poly' | 'mono';
export type OscQuality = 'classic' | 'hq';

export interface OscParams {
  enabled: boolean;
  waveform: OscWaveform;
  /** semitones */
  coarse: number;
  /** cents */
  fine: number;
  /** 0..1 */
  level: number;
  /** -1..1 */
  pan: number;
  /** Total stereo spread in cents (L detuned down by half, R up by half). */
  stereoDetune: number;
  /** Phase offset of the right channel, 0..1 of a cycle. */
  stereoPhase: number;
  phaseMode: PhaseMode;
  /** Start phase used in 'reset' mode, 0..1 of a cycle. */
  startPhase: number;
  /** Pulse width for the pulse waveform, 0.05..0.95 */
  pulseWidth: number;
}

export interface EnvelopeParams {
  /** seconds */
  attack: number;
  /** seconds */
  decay: number;
  /** 0..1 */
  sustain: number;
  /** seconds */
  release: number;
}

export interface FilterParams {
  enabled: boolean;
  type: FilterType;
  /** Hz */
  cutoff: number;
  /** 0..1 */
  resonance: number;
  /** -1..1, scaled to ±FILTER_ENV_OCTAVES */
  envAmount: number;
  /** 0..1 (1 = cutoff follows the keyboard 1:1) */
  keyTrack: number;
}

export interface LfoParams {
  waveform: LfoWaveform;
  /** Hz */
  rate: number;
  /** 0..1 */
  depth: number;
  target: LfoTarget;
}

export interface VoiceParams {
  mode: VoiceMode;
  legato: boolean;
  /** Glide/portamento time in seconds (0 = off) */
  glide: number;
  /** Max simultaneous voices in poly mode, 1..MAX_VOICES */
  polyphony: number;
  /** Pitch bend range in semitones */
  bendRange: number;
  /** Velocity sensitivity 0..1 */
  velocitySens: number;
}

export interface TriOscPatch {
  oscs: [OscParams, OscParams, OscParams];
  /** When true, osc 3 amplitude-modulates osc 1 + 2 instead of being heard directly. */
  amMode: boolean;
  quality: OscQuality;
  ampEnv: EnvelopeParams;
  filter: FilterParams;
  filterEnv: EnvelopeParams;
  lfo: LfoParams;
  voice: VoiceParams;
  /** Output level 0..1 */
  master: number;
}

export const MAX_VOICES = 16;
export const FILTER_ENV_OCTAVES = 6;
export const LFO_CUTOFF_OCTAVES = 4;
export const LFO_PITCH_SEMITONES = 12;

export type ParamCurve = 'linear' | 'exp';

export interface NumericParamSpec {
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  curve: ParamCurve;
  unit?: string;
  format: (v: number) => string;
  /** Double-click resets to this value */
  bipolar?: boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const panFmt = (v: number) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`);

export const PARAM_SPECS = {
  coarse: { label: 'Coarse', min: -24, max: 24, default: 0, step: 1, curve: 'linear', unit: 'st', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} st` },
  fine: { label: 'Fine', min: -100, max: 100, default: 0, step: 1, curve: 'linear', unit: 'ct', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ct` },
  level: { label: 'Level', min: 0, max: 1, default: 0.8, curve: 'linear', format: pct },
  pan: { label: 'Pan', min: -1, max: 1, default: 0, curve: 'linear', bipolar: true, format: panFmt },
  stereoDetune: { label: 'St.Det', min: 0, max: 100, default: 0, step: 1, curve: 'linear', format: (v) => `${Math.round(v)} ct` },
  stereoPhase: { label: 'St.Phs', min: 0, max: 1, default: 0, curve: 'linear', format: (v) => `${Math.round(v * 360)}°` },
  startPhase: { label: 'Phase', min: 0, max: 1, default: 0, curve: 'linear', format: (v) => `${Math.round(v * 360)}°` },
  pulseWidth: { label: 'PW', min: 0.05, max: 0.95, default: 0.5, curve: 'linear', format: pct },
  attack: { label: 'Attack', min: 0.001, max: 10, default: 0.005, curve: 'exp', format: secs },
  decay: { label: 'Decay', min: 0.001, max: 10, default: 0.3, curve: 'exp', format: secs },
  sustain: { label: 'Sustain', min: 0, max: 1, default: 0.8, curve: 'linear', format: pct },
  release: { label: 'Release', min: 0.005, max: 15, default: 0.25, curve: 'exp', format: secs },
  cutoff: { label: 'Cutoff', min: 20, max: 20000, default: 20000, curve: 'exp', format: hz },
  resonance: { label: 'Reso', min: 0, max: 0.95, default: 0.1, curve: 'linear', format: pct },
  envAmount: { label: 'Env Amt', min: -1, max: 1, default: 0, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${(v * FILTER_ENV_OCTAVES).toFixed(1)} oct` },
  keyTrack: { label: 'KeyTrk', min: 0, max: 1, default: 0, curve: 'linear', format: pct },
  lfoRate: { label: 'Rate', min: 0.05, max: 20, default: 5, curve: 'exp', format: (v) => `${v.toFixed(2)} Hz` },
  lfoDepth: { label: 'Depth', min: 0, max: 1, default: 0, curve: 'linear', format: pct },
  glide: { label: 'Glide', min: 0, max: 2, default: 0, curve: 'linear', format: (v) => (v <= 0.0005 ? 'Off' : secs(v)) },
  polyphony: { label: 'Voices', min: 1, max: MAX_VOICES, default: MAX_VOICES, step: 1, curve: 'linear', format: (v) => String(Math.round(v)) },
  bendRange: { label: 'Bend', min: 0, max: 24, default: 2, step: 1, curve: 'linear', format: (v) => `±${Math.round(v)} st` },
  velocitySens: { label: 'Vel', min: 0, max: 1, default: 0.7, curve: 'linear', format: pct },
  master: { label: 'Master', min: 0, max: 1, default: 0.8, curve: 'linear', format: pct },
} satisfies Record<string, NumericParamSpec>;

export type ParamKey = keyof typeof PARAM_SPECS;

export function clampParam(key: ParamKey, v: number): number {
  const s: NumericParamSpec = PARAM_SPECS[key];
  let x = Math.min(s.max, Math.max(s.min, Number.isFinite(v) ? v : s.default));
  if (s.step) x = Math.round(x / s.step) * s.step;
  return x;
}

/** Map a normalized 0..1 control position to a parameter value (respecting exp curves). */
export function fromNormalized(spec: NumericParamSpec, n: number): number {
  const t = Math.min(1, Math.max(0, n));
  let v: number;
  if (spec.curve === 'exp' && spec.min > 0) {
    v = spec.min * Math.pow(spec.max / spec.min, t);
  } else {
    v = spec.min + (spec.max - spec.min) * t;
  }
  if (spec.step) v = Math.round(v / spec.step) * spec.step;
  return v;
}

export function toNormalized(spec: NumericParamSpec, v: number): number {
  if (spec.curve === 'exp' && spec.min > 0) {
    return Math.log(Math.max(spec.min, v) / spec.min) / Math.log(spec.max / spec.min);
  }
  return (v - spec.min) / (spec.max - spec.min);
}

export function defaultOsc(overrides: Partial<OscParams> = {}): OscParams {
  return {
    enabled: true,
    waveform: 'sine',
    coarse: 0,
    fine: 0,
    level: 0.8,
    pan: 0,
    stereoDetune: 0,
    stereoPhase: 0,
    phaseMode: 'reset',
    startPhase: 0,
    pulseWidth: 0.5,
    ...overrides,
  };
}

export function defaultPatch(): TriOscPatch {
  return {
    oscs: [defaultOsc(), defaultOsc({ enabled: false, level: 0.5 }), defaultOsc({ enabled: false, level: 0.5 })],
    amMode: false,
    quality: 'hq',
    ampEnv: { attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.25 },
    filter: { enabled: false, type: 'lowpass', cutoff: 20000, resonance: 0.1, envAmount: 0, keyTrack: 0 },
    filterEnv: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.3 },
    lfo: { waveform: 'sine', rate: 5, depth: 0, target: 'off' },
    voice: { mode: 'poly', legato: false, glide: 0, polyphony: MAX_VOICES, bendRange: 2, velocitySens: 0.7 },
    master: 0.8,
  };
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function num(v: unknown, key: ParamKey): number {
  return clampParam(key, typeof v === 'number' ? v : PARAM_SPECS[key].default);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Validate and normalize an untrusted patch (from a preset file or a stored
 * project). Missing or out-of-range fields are replaced by defaults, so a
 * patch is always safe to hand to the DSP.
 */
export function sanitizePatch(input: unknown): TriOscPatch {
  const d = defaultPatch();
  const p = rec(input);
  const oscsIn = Array.isArray(p.oscs) ? p.oscs : [];
  const oscs = d.oscs.map((def, i) => {
    const o = rec(oscsIn[i]);
    return {
      enabled: bool(o.enabled, def.enabled),
      waveform: pick(o.waveform, OSC_WAVEFORMS, def.waveform),
      coarse: num(o.coarse, 'coarse'),
      fine: num(o.fine, 'fine'),
      level: num(o.level ?? def.level, 'level'),
      pan: num(o.pan, 'pan'),
      stereoDetune: num(o.stereoDetune, 'stereoDetune'),
      stereoPhase: num(o.stereoPhase, 'stereoPhase'),
      phaseMode: pick(o.phaseMode, PHASE_MODES, def.phaseMode),
      startPhase: num(o.startPhase, 'startPhase'),
      pulseWidth: num(o.pulseWidth, 'pulseWidth'),
    } satisfies OscParams;
  }) as [OscParams, OscParams, OscParams];
  const env = (v: unknown, def: EnvelopeParams): EnvelopeParams => {
    const e = rec(v);
    return {
      attack: num(e.attack ?? def.attack, 'attack'),
      decay: num(e.decay ?? def.decay, 'decay'),
      sustain: num(e.sustain ?? def.sustain, 'sustain'),
      release: num(e.release ?? def.release, 'release'),
    };
  };
  const f = rec(p.filter);
  const l = rec(p.lfo);
  const v = rec(p.voice);
  return {
    oscs,
    amMode: bool(p.amMode, d.amMode),
    quality: pick(p.quality, ['classic', 'hq'] as const, d.quality),
    ampEnv: env(p.ampEnv, d.ampEnv),
    filter: {
      enabled: bool(f.enabled, d.filter.enabled),
      type: pick(f.type, FILTER_TYPES, d.filter.type),
      cutoff: num(f.cutoff ?? d.filter.cutoff, 'cutoff'),
      resonance: num(f.resonance ?? d.filter.resonance, 'resonance'),
      envAmount: num(f.envAmount, 'envAmount'),
      keyTrack: num(f.keyTrack, 'keyTrack'),
    },
    filterEnv: env(p.filterEnv, d.filterEnv),
    lfo: {
      waveform: pick(l.waveform, LFO_WAVEFORMS, d.lfo.waveform),
      rate: num(l.rate ?? d.lfo.rate, 'lfoRate'),
      depth: num(l.depth, 'lfoDepth'),
      target: pick(l.target, LFO_TARGETS, d.lfo.target),
    },
    voice: {
      mode: pick(v.mode, ['poly', 'mono'] as const, d.voice.mode),
      legato: bool(v.legato, d.voice.legato),
      glide: num(v.glide, 'glide'),
      polyphony: num(v.polyphony ?? d.voice.polyphony, 'polyphony'),
      bendRange: num(v.bendRange ?? d.voice.bendRange, 'bendRange'),
      velocitySens: num(v.velocitySens ?? d.voice.velocitySens, 'velocitySens'),
    },
    master: num(p.master ?? d.master, 'master'),
  };
}
