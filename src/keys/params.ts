/**
 * Keyforge — multi-engine keyboard instrument. Parameter definitions for each
 * engine live here (ranges, defaults, groups, formatting) so the DSP, UI,
 * presets and automation share one source of truth.
 */
import type { NumericParamSpec } from '../synth/params';

export type KeysEngineType = 'piano' | 'epiano' | 'organ' | 'analog';

export interface KeysParamSpec extends NumericParamSpec {
  key: string;
  group: string;
  /** discrete choices shown as buttons instead of a knob */
  choices?: { value: number; label: string }[];
}

export interface KeysConfigData {
  engine: KeysEngineType;
  params: Record<string, number>;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const cents = (v: number) => `${v.toFixed(1)} ct`;
/** delay time in beats (quarter notes) → musical name */
const DELAY_NAMES: Record<number, string> = { 1: '1/16', 2: '1/8', 3: '1/8 dot', 4: '1/4', 5: '5/16', 6: '1/4 dot', 7: '7/16', 8: '1/2' };
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);

function p(key: string, group: string, label: string, min: number, max: number, def: number, format: (v: number) => string, curve: 'linear' | 'exp' = 'linear', extra: Partial<KeysParamSpec> = {}): KeysParamSpec {
  return { key, group, label, min, max, default: def, format, curve, ...extra };
}

const MASTER = p('master', 'Output', 'Volume', 0, 1.5, 0.8, pct);

export const KEYS_ENGINES: Record<KeysEngineType, { label: string; description: string; color: string; params: KeysParamSpec[] }> = {
  piano: {
    label: 'Piano',
    description: 'Modal string model: inharmonic partials, two detuned strings per note, hammer and dampers.',
    color: '#e8d3a8',
    params: [
      p('brightness', 'Hammer', 'Bright', 0, 1, 0.55, pct),
      p('hardness', 'Hammer', 'Touch', 0, 1, 0.72, pct),
      p('hit', 'Hammer', 'Hit', 0, 1, 0.6, pct),
      p('hammerNoise', 'Hammer', 'Thump', 0, 1, 0.35, pct),
      p('strike', 'Hammer', 'Strike Pos', 0.06, 0.2, 0.125, (v) => `1/${(1 / v).toFixed(1)}`),
      p('sustain', 'String', 'Sustain', 0.25, 2.5, 1, (v) => `×${v.toFixed(2)}`, 'exp'),
      p('damping', 'String', 'Hi Damp', 0, 1, 0.3, pct),
      p('unison', 'String', 'Unison', 0, 6, 0.8, cents),
      p('inharm', 'String', 'Inharm', 0, 2, 1, (v) => `×${v.toFixed(2)}`),
      p('stretch', 'String', 'Stretch', 0, 1.5, 1, (v) => `×${v.toFixed(2)}`),
      p('metal', 'String', 'Metal', 0, 1, 0.5, pct),
      p('damper', 'Dampers', 'Damper', 0, 1, 0.7, pct),
      p('releaseNoise', 'Dampers', 'Key-off', 0, 1, 0.3, pct),
      p('resonance', 'Body', 'Sympath.', 0, 1, 0.4, pct),
      p('body', 'Body', 'Body', 0, 1, 0.45, pct),
      p('tone', 'Body', 'Lid', 1500, 20000, 16000, hz, 'exp'),
      p('room', 'Body', 'Room', 0, 1, 0.3, pct),
      p('width', 'Output', 'Width', 0, 1, 0.6, pct),
      p('velCurve', 'Output', 'Dynamics', 0.5, 2.5, 1.6, (v) => v.toFixed(2)),
      MASTER,
    ],
  },
  epiano: {
    label: 'Electric Piano',
    description: 'Tine model: struck tine with metallic transient through an asymmetric magnetic pickup.',
    color: '#f4a261',
    params: [
      p('bell', 'Tine', 'Bell', 0, 1, 0.45, pct),
      p('bark', 'Tine', 'Bark', 0, 1, 0.4, pct),
      p('decay', 'Tine', 'Decay', 0.25, 2.5, 1, (v) => `×${v.toFixed(2)}`, 'exp'),
      p('hardness', 'Tine', 'Touch', 0, 1, 0.6, pct),
      p('damper', 'Tine', 'Damper', 0, 1, 0.6, pct),
      p('tremRate', 'Tremolo', 'Rate', 0.5, 9, 4.2, (v) => `${v.toFixed(1)} Hz`, 'exp'),
      p('tremDepth', 'Tremolo', 'Depth', 0, 1, 0, pct),
      p('drive', 'Preamp', 'Drive', 0, 1, 0.2, pct),
      p('tone', 'Preamp', 'Tone', 800, 16000, 7000, hz, 'exp'),
      p('velCurve', 'Output', 'Dynamics', 0.5, 2.5, 1.4, (v) => v.toFixed(2)),
      MASTER,
    ],
  },
  organ: {
    label: 'Tonewheel Organ',
    description: 'Nine drawbars, key click, percussion, overdrive and a rotary speaker with inertia.',
    color: '#c77dff',
    params: [
      ...['16′', '5⅓′', '8′', '4′', '2⅔′', '2′', '1⅗′', '1⅓′', '1′'].map((label, i) =>
        p(`db${i}`, 'Drawbars', label, 0, 8, [8, 8, 8, 0, 0, 0, 0, 0, 0][i] ?? 0, (v) => v.toFixed(1), 'linear', { step: 0.1 }),
      ),
      p('click', 'Voice', 'Click', 0, 1, 0.5, pct),
      p('perc', 'Percussion', 'Perc', 0, 1, 1, (v) => (v >= 0.5 ? 'On' : 'Off'), 'linear', { step: 1, choices: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] }),
      p('percHarm', 'Percussion', 'Harm', 2, 3, 3, (v) => (v >= 2.5 ? '3rd' : '2nd'), 'linear', { step: 1, choices: [{ value: 2, label: '2nd' }, { value: 3, label: '3rd' }] }),
      p('percDecay', 'Percussion', 'Decay', 0.1, 1.5, 0.25, secs, 'exp'),
      p('percLevel', 'Percussion', 'Level', 0, 1, 0.6, pct),
      p('drive', 'Preamp', 'Drive', 0, 1, 0.25, pct),
      p('rotor', 'Rotary', 'Speed', 0, 1, 0, (v) => (v >= 0.5 ? 'Fast' : 'Slow'), 'linear', { step: 1, choices: [{ value: 0, label: 'Slow' }, { value: 1, label: 'Fast' }] }),
      p('rotorMix', 'Rotary', 'Rotary', 0, 1, 0.8, pct),
      p('vibrato', 'Voice', 'Chorus', 0, 1, 0, pct),
      MASTER,
    ],
  },
  analog: {
    label: 'Analog',
    description: 'Unison saw synth with sub, resonant filter, drive and stereo ensemble — pads to techno.',
    color: '#4cc9f0',
    params: [
      p('unison', 'Oscillators', 'Voices', 1, 7, 5, (v) => String(Math.round(v)), 'linear', { step: 1 }),
      p('detune', 'Oscillators', 'Detune', 0, 60, 18, cents),
      p('spread', 'Oscillators', 'Spread', 0, 1, 0.7, pct),
      p('sub', 'Oscillators', 'Sub', 0, 1, 0.2, pct),
      p('noise', 'Oscillators', 'Noise', 0, 1, 0.03, pct),
      p('cutoff', 'Filter', 'Cutoff', 40, 18000, 2200, hz, 'exp'),
      p('reso', 'Filter', 'Reso', 0, 0.95, 0.15, pct),
      p('envAmt', 'Filter', 'Env Amt', -1, 1, 0.3, (v) => `${(v * 6).toFixed(1)} oct`, 'linear', { bipolar: true }),
      p('keyTrack', 'Filter', 'KeyTrk', 0, 1, 0.4, pct),
      p('velFilter', 'Filter', 'Velo→Flt', 0, 1, 0.3, pct),
      p('fAttack', 'Filter Env', 'Attack', 0.001, 6, 0.4, secs, 'exp'),
      p('fDecay', 'Filter Env', 'Decay', 0.005, 8, 1.2, secs, 'exp'),
      p('fSustain', 'Filter Env', 'Sustain', 0, 1, 0.4, pct),
      p('fRelease', 'Filter Env', 'Release', 0.005, 10, 1.5, secs, 'exp'),
      p('attack', 'Amp Env', 'Attack', 0.001, 8, 0.6, secs, 'exp'),
      p('decay', 'Amp Env', 'Decay', 0.005, 8, 1, secs, 'exp'),
      p('sustainLvl', 'Amp Env', 'Sustain', 0, 1, 0.85, pct),
      p('release', 'Amp Env', 'Release', 0.005, 12, 2, secs, 'exp'),
      p('lfoRate', 'Motion', 'Rate', 0.05, 12, 0.25, (v) => `${v.toFixed(2)} Hz`, 'exp'),
      p('lfoDepth', 'Motion', 'Flt Mod', 0, 3, 0, (v) => `${v.toFixed(2)} oct`),
      p('space', 'FX', 'Space', 0, 1, 0, pct),
      p('delayMix', 'FX', 'Delay', 0, 1, 0, pct),
      p('delayBeats', 'FX', 'Time', 0.25, 2, 0.75, (v) => DELAY_NAMES[Math.round(v * 4)] ?? `${v} beats`, 'linear', { step: 0.25 }),
      p('drive', 'Output', 'Drive', 0, 1, 0.1, pct),
      p('ensemble', 'Output', 'Ensemble', 0, 1, 0.5, pct),
      p('mono', 'Output', 'Mode', 0, 1, 0, (v) => (v >= 0.5 ? 'Mono' : 'Poly'), 'linear', { step: 1, choices: [{ value: 0, label: 'Poly' }, { value: 1, label: 'Mono' }] }),
      p('glide', 'Output', 'Glide', 0, 1, 0, (v) => (v <= 0.0005 ? 'Off' : secs(v))),
      MASTER,
    ],
  },
};

export const KEYS_ENGINE_TYPES = Object.keys(KEYS_ENGINES) as KeysEngineType[];

export function keysSpec(engine: KeysEngineType, key: string): KeysParamSpec | undefined {
  return KEYS_ENGINES[engine].params.find((s) => s.key === key);
}

export function defaultKeysParams(engine: KeysEngineType): Record<string, number> {
  return Object.fromEntries(KEYS_ENGINES[engine].params.map((s) => [s.key, s.default]));
}

/** Validate untrusted params: unknown keys dropped, missing ones defaulted, values clamped. */
export function sanitizeKeysParams(engine: KeysEngineType, raw: unknown): Record<string, number> {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const s of KEYS_ENGINES[engine].params) {
    const v = r[s.key];
    const x = typeof v === 'number' && Number.isFinite(v) ? v : s.default;
    out[s.key] = Math.min(s.max, Math.max(s.min, x));
  }
  return out;
}
