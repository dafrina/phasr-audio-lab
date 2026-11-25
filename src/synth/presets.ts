/**
 * TriOsc presets. Presets are versioned JSON documents containing a complete
 * patch; factory presets are defined as overrides on top of the default patch
 * and then normalized through sanitizePatch so they are always complete.
 */
import { defaultOsc, defaultPatch, sanitizePatch, type OscParams, type TriOscPatch } from './params';

export const PRESET_FORMAT = 'triosc-preset';
export const PRESET_VERSION = 1;

export interface TriOscPreset {
  format: typeof PRESET_FORMAT;
  version: number;
  name: string;
  category: string;
  factory: boolean;
  patch: TriOscPatch;
}

type PatchOverrides = Partial<Omit<TriOscPatch, 'oscs' | 'ampEnv' | 'filter' | 'filterEnv' | 'lfo' | 'voice'>> & {
  oscs?: [Partial<OscParams>, Partial<OscParams>, Partial<OscParams>];
  ampEnv?: Partial<TriOscPatch['ampEnv']>;
  filter?: Partial<TriOscPatch['filter']>;
  filterEnv?: Partial<TriOscPatch['filterEnv']>;
  lfo?: Partial<TriOscPatch['lfo']>;
  voice?: Partial<TriOscPatch['voice']>;
};

function build(o: PatchOverrides): TriOscPatch {
  const d = defaultPatch();
  // unspecified oscillator fields fall back to the init patch, so 'Init Sine' equals defaultPatch()
  const oscs = (o.oscs ?? [{}, {}, {}]).map((ov, i) => ({ ...(d.oscs[i] ?? defaultOsc()), ...ov }));
  return sanitizePatch({
    ...d,
    ...o,
    oscs,
    ampEnv: { ...d.ampEnv, ...o.ampEnv },
    filter: { ...d.filter, ...o.filter },
    filterEnv: { ...d.filterEnv, ...o.filterEnv },
    lfo: { ...d.lfo, ...o.lfo },
    voice: { ...d.voice, ...o.voice },
  });
}

function preset(name: string, category: string, o: PatchOverrides): TriOscPreset {
  return { format: PRESET_FORMAT, version: PRESET_VERSION, name, category, factory: true, patch: build(o) };
}

export const FACTORY_PRESETS: TriOscPreset[] = [
  preset('Init Sine', 'Init', {}),
  preset('Sub Bass', 'Bass', {
    oscs: [
      { waveform: 'sine', coarse: -12, level: 0.9 },
      { enabled: true, waveform: 'triangle', coarse: -12, level: 0.25 },
      { enabled: false },
    ],
    ampEnv: { attack: 0.003, decay: 0.2, sustain: 0.9, release: 0.12 },
    voice: { mode: 'mono', legato: true, glide: 0.04, velocitySens: 0.3 },
  }),
  preset('Deep Bass', 'Bass', {
    oscs: [
      { waveform: 'saw', coarse: -12, level: 0.7 },
      { enabled: true, waveform: 'square', coarse: -24, level: 0.5 },
      { enabled: true, waveform: 'saw', coarse: -12, fine: 8, level: 0.5 },
    ],
    filter: { enabled: true, type: 'lowpass', cutoff: 180, resonance: 0.35, envAmount: 0.45, keyTrack: 0.3 },
    filterEnv: { attack: 0.002, decay: 0.25, sustain: 0.15, release: 0.2 },
    ampEnv: { attack: 0.002, decay: 0.3, sustain: 0.85, release: 0.12 },
    voice: { mode: 'mono', legato: false, glide: 0, velocitySens: 0.5 },
  }),
  preset('Detuned Saw', 'Lead', {
    oscs: [
      { waveform: 'saw', level: 0.7, stereoDetune: 18, phaseMode: 'random' },
      { enabled: true, waveform: 'saw', fine: 12, level: 0.6, pan: -0.4, phaseMode: 'random' },
      { enabled: true, waveform: 'saw', fine: -12, level: 0.6, pan: 0.4, phaseMode: 'random' },
    ],
    filter: { enabled: true, cutoff: 4500, resonance: 0.15, envAmount: 0.15 },
    ampEnv: { attack: 0.01, decay: 0.4, sustain: 0.8, release: 0.35 },
  }),
  preset('Square Lead', 'Lead', {
    oscs: [
      { waveform: 'square', level: 0.75 },
      { enabled: true, waveform: 'square', coarse: 12, fine: 5, level: 0.3 },
      { enabled: false },
    ],
    filter: { enabled: true, cutoff: 3200, resonance: 0.3, envAmount: 0.25 },
    filterEnv: { attack: 0.005, decay: 0.3, sustain: 0.4, release: 0.3 },
    lfo: { waveform: 'sine', rate: 5.5, depth: 0.12, target: 'pitch' },
    ampEnv: { attack: 0.005, decay: 0.2, sustain: 0.85, release: 0.2 },
    voice: { mode: 'mono', legato: true, glide: 0.06 },
  }),
  preset('Soft Pad', 'Pad', {
    oscs: [
      { waveform: 'saw', level: 0.5, stereoDetune: 22, phaseMode: 'random' },
      { enabled: true, waveform: 'triangle', coarse: 12, level: 0.4, stereoPhase: 0.25, phaseMode: 'random' },
      { enabled: true, waveform: 'saw', fine: -9, level: 0.4, stereoDetune: 14, phaseMode: 'random' },
    ],
    filter: { enabled: true, cutoff: 1400, resonance: 0.1, envAmount: 0.2, keyTrack: 0.5 },
    filterEnv: { attack: 1.2, decay: 1.5, sustain: 0.6, release: 2 },
    ampEnv: { attack: 0.9, decay: 1.2, sustain: 0.8, release: 2.2 },
    lfo: { waveform: 'triangle', rate: 0.25, depth: 0.25, target: 'cutoff' },
  }),
  preset('Pluck', 'Pluck', {
    oscs: [
      { waveform: 'saw', level: 0.7 },
      { enabled: true, waveform: 'pulse', pulseWidth: 0.3, coarse: 12, level: 0.35 },
      { enabled: false },
    ],
    filter: { enabled: true, cutoff: 350, resonance: 0.3, envAmount: 0.7, keyTrack: 0.6 },
    filterEnv: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.2 },
    ampEnv: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.3 },
  }),
  preset('808 Bass', 'Bass', {
    oscs: [
      { waveform: 'sine', coarse: -12, level: 1 },
      { enabled: true, waveform: 'triangle', coarse: -12, level: 0.15 },
      { enabled: false },
    ],
    ampEnv: { attack: 0.001, decay: 1.6, sustain: 0, release: 0.4 },
    voice: { mode: 'mono', legato: false, glide: 0.08, velocitySens: 0.4 },
    master: 0.9,
  }),
  preset('Retro Game Lead', 'Lead', {
    oscs: [
      { waveform: 'pulse', pulseWidth: 0.25, level: 0.7 },
      { enabled: true, waveform: 'square', coarse: 12, level: 0.2 },
      { enabled: false },
    ],
    quality: 'classic',
    ampEnv: { attack: 0.001, decay: 0.12, sustain: 0.7, release: 0.06 },
    lfo: { waveform: 'square', rate: 12, depth: 0.0, target: 'off' },
    voice: { mode: 'mono', legato: false, glide: 0.02, velocitySens: 0 },
  }),
  preset('Noise Percussion', 'Drums', {
    oscs: [
      { waveform: 'noise', level: 0.8, stereoDetune: 1 },
      { enabled: true, waveform: 'sine', coarse: -12, level: 0.5 },
      { enabled: false },
    ],
    filter: { enabled: true, type: 'bandpass', cutoff: 2500, resonance: 0.4, envAmount: 0.35, keyTrack: 1 },
    filterEnv: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.08 },
    ampEnv: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.1 },
    voice: { velocitySens: 0.9 },
  }),
  preset('Ambient Pad', 'Pad', {
    oscs: [
      { waveform: 'triangle', level: 0.6, stereoDetune: 30, phaseMode: 'random' },
      { enabled: true, waveform: 'sine', coarse: 7, level: 0.3, stereoPhase: 0.5 },
      { enabled: true, waveform: 'sine', coarse: -24, level: 0.6 },
    ],
    amMode: true,
    lfo: { waveform: 'sine', rate: 0.15, depth: 0.3, target: 'amp' },
    ampEnv: { attack: 2.2, decay: 2, sustain: 0.85, release: 4 },
    filter: { enabled: true, cutoff: 2600, resonance: 0.2, keyTrack: 0.4 },
  }),
  preset('Simple Organ', 'Keys', {
    oscs: [
      { waveform: 'sine', level: 0.6 },
      { enabled: true, waveform: 'sine', coarse: 12, level: 0.4 },
      { enabled: true, waveform: 'sine', coarse: 19, level: 0.25 },
    ],
    ampEnv: { attack: 0.004, decay: 0.05, sustain: 1, release: 0.06 },
    lfo: { waveform: 'sine', rate: 6.2, depth: 0.18, target: 'amp' },
    voice: { velocitySens: 0 },
  }),
];

export function presetToJson(p: TriOscPreset): string {
  return JSON.stringify(p, null, 2);
}

export class PresetFormatError extends Error {}

/** Parse and validate a preset document (from storage or a file). */
export function presetFromJson(json: string | unknown): TriOscPreset {
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      throw new PresetFormatError('Preset is not valid JSON.');
    }
  }
  if (raw === null || typeof raw !== 'object') throw new PresetFormatError('Preset is not an object.');
  const r = raw as Record<string, unknown>;
  if (r.format !== PRESET_FORMAT) throw new PresetFormatError('Not a TriOsc preset.');
  const version = typeof r.version === 'number' ? r.version : 0;
  if (version > PRESET_VERSION) throw new PresetFormatError(`Preset version ${version} is newer than supported.`);
  return {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 64) : 'Untitled',
    category: typeof r.category === 'string' ? r.category : 'User',
    factory: false,
    patch: sanitizePatch(r.patch),
  };
}

export function makeUserPreset(name: string, patch: TriOscPatch): TriOscPreset {
  return { format: PRESET_FORMAT, version: PRESET_VERSION, name, category: 'User', factory: false, patch: structuredClone(patch) };
}

// ---------------------------------------------------------------------------
// User preset persistence (localStorage; small JSON documents)
// ---------------------------------------------------------------------------

const USER_PRESETS_KEY = 'phasr.triosc.userPresets.v1';

export function loadUserPresets(): TriOscPreset[] {
  try {
    const raw = globalThis.localStorage?.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: TriOscPreset[] = [];
    for (const item of arr) {
      try {
        out.push(presetFromJson(item));
      } catch {
        // skip invalid entries rather than failing the whole list
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserPresets(presets: TriOscPreset[]): boolean {
  try {
    globalThis.localStorage?.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}
