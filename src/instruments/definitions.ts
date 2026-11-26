/**
 * Instrument registry — pure part (no Web Audio, no React).
 *
 * Adding a new instrument (e.g. a piano synth):
 *   1. add its config to `InstrumentConfig` in project/types.ts
 *   2. register a definition here (defaults, validation, labels)
 *   3. register its audio node factory in audio/instruments.ts
 *   4. register its icon + editor window in ui/instruments.tsx
 * All three registries are `Record<InstrumentType, …>`, so the compiler
 * reports any step that was missed.
 */
import { defaultKit, DRUM_BASE_NOTE, FACTORY_KITS, kitAssetIds, padIndexForNote, sanitizeKit } from '../drums/kit';
import type { DrumPad, InstrumentConfig } from '../project/types';
import type { AutoParamInfo } from '../project/automation';
import { DRUM_SPECS } from '../drums/kit';
import { PARAM_SPECS, type NumericParamSpec, type TriOscPatch } from '../synth/params';
import { defaultPatch, sanitizePatch } from '../synth/params';
import { KEYS_ENGINES, KEYS_ENGINE_TYPES, sanitizeKeysParams, type KeysEngineType } from '../keys/params';
import { KEYS_PRESETS } from '../keys/presets';
import { DEFAULT_SAMPLER_PARAMS, sanitizeSamplerParams, sanitizeZone, type SamplerParams, type SamplerZone } from '../sampler/zones';

const secsFmt = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
/** Sampler parameters that knobs and automation lanes use */
export const SAMPLER_SPECS: Record<keyof SamplerParams, NumericParamSpec> = {
  attack: { label: 'Attack', min: 0.001, max: 5, default: DEFAULT_SAMPLER_PARAMS.attack, curve: 'exp', format: secsFmt },
  release: { label: 'Release', min: 0.005, max: 10, default: DEFAULT_SAMPLER_PARAMS.release, curve: 'exp', format: secsFmt },
  velSens: { label: 'Velocity', min: 0, max: 1, default: DEFAULT_SAMPLER_PARAMS.velSens, curve: 'linear', format: (v) => `${Math.round(v * 100)}%` },
  gain: { label: 'Volume', min: -36, max: 12, default: DEFAULT_SAMPLER_PARAMS.gain, curve: 'linear', format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
  transpose: { label: 'Transpose', min: -24, max: 24, default: 0, step: 1, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} st` },
  oneShot: { label: 'One-shot', min: 0, max: 1, default: 0, step: 1, curve: 'linear', format: (v) => (v >= 0.5 ? 'On' : 'Off') },
};
const SAMPLER_AUTO: AutoParamInfo[] = (['attack', 'release', 'velSens', 'gain', 'transpose'] as const).map((k) => ({ key: k, label: SAMPLER_SPECS[k].label, spec: SAMPLER_SPECS[k] }));

// ---- automatable instrument parameters ----

const ENV_KEYS = ['attack', 'decay', 'sustain', 'release'] as const;

/** TriOsc parameters that can be automated, as dotted patch paths. */
function trioscParams(): AutoParamInfo[] {
  const P = PARAM_SPECS;
  const out: AutoParamInfo[] = [{ key: 'master', label: 'Master', spec: P.master }];
  for (const k of ENV_KEYS) out.push({ key: `ampEnv.${k}`, label: `Amp ${P[k].label}`, spec: P[k] });
  out.push(
    { key: 'filter.cutoff', label: 'Cutoff', spec: P.cutoff },
    { key: 'filter.resonance', label: 'Resonance', spec: P.resonance },
    { key: 'filter.envAmount', label: 'Filter Env Amt', spec: P.envAmount },
    { key: 'filter.keyTrack', label: 'Key Track', spec: P.keyTrack },
  );
  for (const k of ENV_KEYS) out.push({ key: `filterEnv.${k}`, label: `Filter ${P[k].label}`, spec: P[k] });
  out.push({ key: 'lfo.rate', label: 'LFO Rate', spec: P.lfoRate }, { key: 'lfo.depth', label: 'LFO Depth', spec: P.lfoDepth }, { key: 'voice.glide', label: 'Glide', spec: P.glide });
  for (let i = 0; i < 3; i++) {
    out.push(
      { key: `osc${i}.level`, label: `Osc ${i + 1} Level`, spec: P.level },
      { key: `osc${i}.fine`, label: `Osc ${i + 1} Fine`, spec: P.fine },
      { key: `osc${i}.pan`, label: `Osc ${i + 1} Pan`, spec: P.pan },
      { key: `osc${i}.pulseWidth`, label: `Osc ${i + 1} PW`, spec: P.pulseWidth },
    );
  }
  return out;
}
const TRIOSC_AUTO = trioscParams();

/** Read a dotted TriOsc path ("ampEnv.release", "osc1.level", "master"). */
export function trioscValue(patch: TriOscPatch, key: string): number | null {
  const [a, b] = key.split('.');
  if (a === 'master' && !b) return patch.master;
  const osc = /^osc(\d)$/.exec(a ?? '');
  const obj: unknown = osc ? patch.oscs[Number(osc[1])] : (patch as unknown as Record<string, unknown>)[a ?? ''];
  const v = obj && b ? (obj as Record<string, unknown>)[b] : undefined;
  return typeof v === 'number' ? v : null;
}

const PAD_FIELDS: { field: 'gain' | 'pan' | 'tune' | 'decay'; spec: NumericParamSpec }[] = [
  { field: 'gain', spec: DRUM_SPECS.gain },
  { field: 'pan', spec: DRUM_SPECS.pan },
  { field: 'tune', spec: DRUM_SPECS.tune },
  { field: 'decay', spec: DRUM_SPECS.decay },
];

export function parsePadKey(key: string): { pad: number; field: 'gain' | 'pan' | 'tune' | 'decay' } | null {
  const m = /^p(\d{1,2})\.(gain|pan|tune|decay)$/.exec(key);
  if (!m) return null;
  const pad = Number(m[1]);
  return pad >= 0 && pad < 16 ? { pad, field: m[2] as 'gain' | 'pan' | 'tune' | 'decay' } : null;
}

/** Keyforge: every numeric parameter of the active engine is automatable (flat keys). */
const KEYS_AUTO = Object.fromEntries(
  KEYS_ENGINE_TYPES.map((e) => [
    e,
    KEYS_ENGINES[e].params.map((s) => ({ key: s.key, label: s.group === 'Output' || s.group === 'Drawbars' ? s.label : `${s.group} ${s.label}`, spec: s })),
  ]),
) as unknown as Record<KeysEngineType, AutoParamInfo[]>;

function isKeysEngine(v: unknown): v is KeysEngineType {
  return typeof v === 'string' && v in KEYS_ENGINES;
}

export type InstrumentType = InstrumentConfig['type'];
type ConfigOf<T extends InstrumentType> = Extract<InstrumentConfig, { type: T }>;

export interface InstrumentDefinition<T extends InstrumentType = InstrumentType> {
  type: T;
  label: string;
  description: string;
  /** default name for new tracks ("TriOsc 2", "Drums 3") */
  trackName: string;
  createConfig(): ConfigOf<T>;
  /** validate untrusted data (project files); always returns a usable config */
  sanitize(raw: Record<string, unknown>): ConfigOf<T>;
  /** asset ids the instrument needs (samples), for persistence */
  assetIds(config: ConfigOf<T>): string[];
  /** a custom label for a MIDI note (drum pad names in the piano roll), or null */
  noteLabel(config: ConfigOf<T>, note: number): string | null;
  /** the note a "Duck from this track" sidechain should listen to (null = any) */
  defaultSidechainNote(config: ConfigOf<T>): number | null;
  /** parameters that automation lanes can drive */
  automatableParams(config: ConfigOf<T>): AutoParamInfo[];
  /** current static value of an automatable parameter */
  staticValue(config: ConfigOf<T>, key: string): number | null;
}

export const INSTRUMENTS: { [T in InstrumentType]: InstrumentDefinition<T> } = {
  triosc: {
    type: 'triosc',
    label: 'TriOsc',
    description: 'Three-oscillator subtractive synth',
    trackName: 'TriOsc',
    createConfig: () => ({ type: 'triosc', patch: defaultPatch(), presetName: 'Init Sine' }),
    sanitize: (r) => ({ type: 'triosc', patch: sanitizePatch(r.patch), presetName: typeof r.presetName === 'string' ? r.presetName : 'Custom' }),
    assetIds: () => [],
    noteLabel: () => null,
    defaultSidechainNote: () => null,
    automatableParams: () => TRIOSC_AUTO,
    staticValue: (c, key) => trioscValue(c.patch, key),
  },
  drumrack: {
    type: 'drumrack',
    label: 'Drum Rack',
    description: '16-pad drum sampler with built-in synthesized kits',
    trackName: 'Drums',
    createConfig: () => ({ type: 'drumrack', kit: defaultKit(), presetName: FACTORY_KITS[0]?.name ?? 'Kit' }),
    sanitize: (r) => ({ type: 'drumrack', kit: sanitizeKit(r.kit), presetName: typeof r.presetName === 'string' ? r.presetName : 'Custom Kit' }),
    assetIds: (c) => kitAssetIds(c.kit),
    noteLabel: (c, note) => {
      const i = padIndexForNote(note);
      return i >= 0 ? (c.kit.pads[i]?.name ?? null) : null;
    },
    defaultSidechainNote: () => DRUM_BASE_NOTE, // pad 1 = kick
    automatableParams: (c) =>
      c.kit.pads.flatMap((p: DrumPad, i) => PAD_FIELDS.map((f) => ({ key: `p${i}.${f.field}`, label: `${p.name} ${f.spec.label}`, spec: f.spec }))),
    staticValue: (c, key) => {
      const k = parsePadKey(key);
      const pad = k ? c.kit.pads[k.pad] : undefined;
      return k && pad ? pad[k.field] : null;
    },
  },
  keys: {
    type: 'keys',
    label: 'Keyforge',
    description: 'Keyboard instruments: modelled grand piano, tine electric piano, tonewheel organ, analog pads & techno',
    trackName: 'Keys',
    createConfig: () => {
      const p = KEYS_PRESETS[0];
      if (!p) throw new Error('no Keyforge presets');
      return { type: 'keys', engine: p.engine, params: { ...p.params }, presetName: p.name };
    },
    sanitize: (r) => {
      const engine = isKeysEngine(r.engine) ? r.engine : 'piano';
      return { type: 'keys', engine, params: sanitizeKeysParams(engine, r.params), presetName: typeof r.presetName === 'string' ? r.presetName : 'Custom' };
    },
    assetIds: () => [],
    noteLabel: () => null,
    defaultSidechainNote: () => null,
    automatableParams: (c) => KEYS_AUTO[c.engine],
    staticValue: (c, key) => c.params[key] ?? null,
  },
  sampler: {
    type: 'sampler',
    label: 'Sampler',
    description: 'Play your own samples: map one or more to keys and velocities; unmapped keys are pitched from the nearest sample',
    trackName: 'Sampler',
    createConfig: () => ({ type: 'sampler', zones: [], params: { ...DEFAULT_SAMPLER_PARAMS }, autoMap: true, presetName: 'Empty bank' }),
    sanitize: (r) => ({
      type: 'sampler',
      zones: (Array.isArray(r.zones) ? r.zones : []).map(sanitizeZone).filter((z): z is SamplerZone => z !== null).slice(0, 128),
      params: sanitizeSamplerParams(r.params),
      autoMap: r.autoMap !== false,
      presetName: typeof r.presetName === 'string' ? r.presetName : 'Bank',
    }),
    assetIds: (c) => [...new Set(c.zones.map((z) => z.assetId))],
    noteLabel: () => null,
    defaultSidechainNote: () => null,
    automatableParams: () => SAMPLER_AUTO,
    staticValue: (c, key) => (key in c.params ? (c.params[key as keyof SamplerParams] ?? null) : null),
  },
};

export const INSTRUMENT_TYPES = Object.keys(INSTRUMENTS) as InstrumentType[];

/** Look up the definition for a config with its type preserved. */
export function instrumentDef<T extends InstrumentType>(type: T): InstrumentDefinition<T> {
  return INSTRUMENTS[type] as InstrumentDefinition<T>;
}

export function isInstrumentType(v: unknown): v is InstrumentType {
  return typeof v === 'string' && v in INSTRUMENTS;
}

/** Validate any stored instrument config; unknown types fall back to TriOsc. */
export function sanitizeInstrument(raw: unknown): InstrumentConfig {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const type = isInstrumentType(r.type) ? r.type : 'triosc';
  return INSTRUMENTS[type].sanitize(r);
}

export function noteLabelFor(config: InstrumentConfig | null, note: number): string | null {
  if (!config) return null;
  return (INSTRUMENTS[config.type] as InstrumentDefinition).noteLabel(config as never, note);
}

export function instrumentAutoParams(config: InstrumentConfig | null): AutoParamInfo[] {
  if (!config) return [];
  return (INSTRUMENTS[config.type] as InstrumentDefinition).automatableParams(config as never);
}

export function instrumentStaticValue(config: InstrumentConfig | null, key: string): number | null {
  if (!config) return null;
  return (INSTRUMENTS[config.type] as InstrumentDefinition).staticValue(config as never, key);
}

export function sidechainNoteFor(config: InstrumentConfig | null): number | null {
  if (!config) return null;
  return (INSTRUMENTS[config.type] as InstrumentDefinition).defaultSidechainNote(config as never);
}
