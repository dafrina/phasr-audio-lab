/**
 * Drum rack kit model: pad layout, factory kits and validation (pure).
 * Pad i is played by MIDI note DRUM_BASE_NOTE + i (36 = C1, the usual kick note).
 */
import { sanitizeEffect } from '../audio/effects/specs';
import type { DrumKit, DrumPad, DrumPadSource, DrumVoiceType } from '../project/types';
import type { NumericParamSpec } from '../synth/params';

export const DRUM_PADS = 16;
export const DRUM_BASE_NOTE = 36;
export const DRUM_CHOKE_GROUPS = 4;

export const DRUM_VOICES: { type: DrumVoiceType; label: string }[] = [
  { type: 'kick', label: 'Kick' },
  { type: 'snare', label: 'Snare' },
  { type: 'clap', label: 'Clap' },
  { type: 'rim', label: 'Rim' },
  { type: 'tom', label: 'Tom' },
  { type: 'hatClosed', label: 'Closed Hat' },
  { type: 'hatOpen', label: 'Open Hat' },
  { type: 'crash', label: 'Crash' },
  { type: 'cowbell', label: 'Cowbell' },
  { type: 'shaker', label: 'Shaker' },
  { type: 'perc', label: 'Perc' },
  { type: 'zap', label: 'Zap' },
];

/** The characters every built-in voice offers (index = model; 0 = the classic sound). */
export const DRUM_MODELS: Record<DrumVoiceType, string[]> = {
  kick: ['Classic', '909', 'Distorted'],
  snare: ['Classic', '909', 'Trap'],
  clap: ['Classic', '909', 'Snap'],
  rim: ['Classic', 'Woodblock', 'Click'],
  tom: ['Classic', 'Electronic', 'Conga'],
  hatClosed: ['Classic', '808', 'Noise'],
  hatOpen: ['Classic', '808', 'Noise'],
  crash: ['Crash', 'Ride', 'Reverse'],
  cowbell: ['808', 'Agogo', 'Clave'],
  shaker: ['Shaker', 'Tambourine', 'Cabasa'],
  perc: ['FM Blip', 'Bongo', 'Metal Ping'],
  zap: ['Zap', 'Laser', 'Noise Sweep'],
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

export const DRUM_SPECS = {
  tone: { label: 'Tone', min: 0, max: 1, default: 0.5, curve: 'linear', format: pct },
  snap: { label: 'Snap', min: 0, max: 1, default: 0.5, curve: 'linear', format: pct },
  length: { label: 'Length', min: 0.02, max: 3, default: 0.4, curve: 'exp', format: secs },
  gain: { label: 'Gain', min: -36, max: 12, default: 0, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
  pan: { label: 'Pan', min: -1, max: 1, default: 0, curve: 'linear', bipolar: true, format: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`) },
  tune: { label: 'Tune', min: -24, max: 24, default: 0, step: 0.1, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st` },
  decay: { label: 'Decay', min: 0.02, max: 4, default: 4, curve: 'exp', format: (v) => (v >= 3.99 ? 'Full' : secs(v)) },
} satisfies Record<string, NumericParamSpec>;

export function padNote(i: number): number {
  return DRUM_BASE_NOTE + i;
}

export function padIndexForNote(note: number): number {
  const i = note - DRUM_BASE_NOTE;
  return i >= 0 && i < DRUM_PADS ? i : -1;
}

function synth(voice: DrumVoiceType, tone = 0.5, snap = 0.5, length = 0.4, model = 0): DrumPadSource {
  return { kind: 'synth', voice, tone, snap, length, model };
}

function pad(name: string, source: DrumPadSource, o: Partial<DrumPad> = {}): DrumPad {
  return { name, source, gain: 0, pan: 0, tune: 0, decay: 4, choke: 0, eq: null, sends: [0, 0], ...o };
}

/** GM-flavoured layout: kick on 36, snare on 38, hats 42/46 sharing a choke group. */
function kit(variant: 'electro' | 'punchy' | 'lofi'): DrumKit {
  const v = { electro: 0.5, punchy: 0.7, lofi: 0.3 }[variant];
  const pads: DrumPad[] = [
    pad('Kick', synth('kick', 0.45 * v + 0.2, 0.6, variant === 'electro' ? 0.7 : 0.45)),
    pad('Rim', synth('rim', 0.5, 0.6, 0.06), { gain: -4 }),
    pad('Snare', synth('snare', 0.5, 0.5 + v * 0.3, 0.28)),
    pad('Clap', synth('clap', 0.5, 0.6, 0.35), { gain: -2 }),
    pad('Tom Low', synth('tom', 0.2, 0.4, 0.45), { pan: -0.25 }),
    pad('Closed Hat', synth('hatClosed', 0.6, 0.6, 0.06), { gain: -5, choke: 1 }),
    pad('Tom Mid', synth('tom', 0.45, 0.4, 0.4), { pan: 0.05 }),
    pad('Open Hat', synth('hatOpen', 0.6, 0.5, 0.55), { gain: -6, choke: 1 }),
    pad('Tom High', synth('tom', 0.7, 0.4, 0.35), { pan: 0.3 }),
    pad('Crash', synth('crash', 0.5, 0.5, 1.8), { gain: -8 }),
    pad('Shaker', synth('shaker', 0.6, 0.4, 0.12), { gain: -8, pan: 0.35 }),
    pad('Cowbell', synth('cowbell', 0.5, 0.5, 0.3), { gain: -7 }),
    pad('Kick Short', synth('kick', 0.6, 0.8, 0.22)),
    pad('Snare Tight', synth('snare', 0.7, 0.8, 0.14), { gain: -2 }),
    pad('Perc', synth('perc', 0.5, 0.5, 0.18), { gain: -5, pan: -0.3 }),
    pad('Zap', synth('zap', 0.5, 0.5, 0.25), { gain: -6 }),
  ];
  if (variant === 'lofi') for (const p of pads) p.tune = -2;
  return { pads };
}

/** 909-flavoured house / techno kit and a hard techno kit, built from the alternative characters. */
function kit909(): DrumKit {
  return {
    pads: [
      pad('Kick 909', synth('kick', 0.45, 0.6, 0.5, 1)),
      pad('Rim', synth('rim', 0.5, 0.6, 0.06), { gain: -4 }),
      pad('Snare 909', synth('snare', 0.5, 0.6, 0.25, 1)),
      pad('Clap 909', synth('clap', 0.5, 0.6, 0.35, 1), { gain: -2 }),
      pad('Tom Low', synth('tom', 0.2, 0.4, 0.45, 1), { pan: -0.25 }),
      pad('Closed Hat', synth('hatClosed', 0.6, 0.5, 0.05, 1), { gain: -5, choke: 1 }),
      pad('Tom Mid', synth('tom', 0.45, 0.4, 0.4, 1), { pan: 0.05 }),
      pad('Open Hat', synth('hatOpen', 0.6, 0.5, 0.45, 1), { gain: -6, choke: 1 }),
      pad('Tom High', synth('tom', 0.7, 0.4, 0.35, 1), { pan: 0.3 }),
      pad('Ride', synth('crash', 0.5, 0.5, 1.6, 1), { gain: -9 }),
      pad('Tambourine', synth('shaker', 0.5, 0.5, 0.2, 1), { gain: -8, pan: 0.35 }),
      pad('Cowbell', synth('cowbell', 0.5, 0.5, 0.3), { gain: -7 }),
      pad('Kick Short', synth('kick', 0.55, 0.8, 0.25, 1)),
      pad('Snap Clap', synth('clap', 0.6, 0.5, 0.15, 2), { gain: -3 }),
      pad('Bongo', synth('perc', 0.4, 0.5, 0.2, 1), { gain: -5, pan: -0.3 }),
      pad('Noise Hat', synth('hatClosed', 0.7, 0.6, 0.04, 2), { gain: -7, choke: 1 }),
    ],
  };
}
function kitHardTechno(): DrumKit {
  return {
    pads: [
      pad('Kick Distorted', synth('kick', 0.35, 0.6, 0.6, 2), { gain: -2 }),
      pad('Click', synth('rim', 0.7, 0.4, 0.05, 2), { gain: -6 }),
      pad('Snare Trap', synth('snare', 0.5, 0.6, 0.2, 2)),
      pad('Clap 909', synth('clap', 0.55, 0.6, 0.4, 1), { gain: -2 }),
      pad('Tom Electronic', synth('tom', 0.25, 0.6, 0.4, 1), { pan: -0.25 }),
      pad('Hat 808', synth('hatClosed', 0.65, 0.5, 0.05, 1), { gain: -6, choke: 1 }),
      pad('Metal Ping', synth('perc', 0.4, 0.6, 0.3, 2), { gain: -8, pan: 0.2 }),
      pad('Open Hat 808', synth('hatOpen', 0.65, 0.5, 0.4, 1), { gain: -7, choke: 1 }),
      pad('Laser', synth('zap', 0.5, 0.5, 0.25, 1), { gain: -8, pan: 0.3 }),
      pad('Reverse Crash', synth('crash', 0.5, 0.6, 1.2, 2), { gain: -10 }),
      pad('Noise Hat', synth('hatClosed', 0.8, 0.7, 0.03, 2), { gain: -8, pan: 0.35 }),
      pad('Noise Sweep', synth('zap', 0.5, 0.4, 0.8, 2), { gain: -10 }),
      pad('Kick Rumble', synth('kick', 0.25, 0.4, 1.2, 2), { gain: -3 }),
      pad('Snare 909', synth('snare', 0.65, 0.8, 0.18, 1), { gain: -2 }),
      pad('Clave', synth('cowbell', 0.5, 0.5, 0.08, 2), { gain: -8, pan: -0.3 }),
      pad('Zap', synth('zap', 0.5, 0.5, 0.25), { gain: -6 }),
    ],
  };
}

export const FACTORY_KITS: { name: string; kit: DrumKit }[] = [
  { name: 'Electro Kit', kit: kit('electro') },
  { name: 'Punchy Kit', kit: kit('punchy') },
  { name: 'Lo-Fi Kit', kit: kit('lofi') },
  { name: '909 House Kit', kit: kit909() },
  { name: 'Hard Techno Kit', kit: kitHardTechno() },
];

export function defaultKit(): DrumKit {
  return structuredClone((FACTORY_KITS[0] as { kit: DrumKit }).kit);
}

function clamp(v: unknown, s: NumericParamSpec): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : s.default;
  return Math.min(s.max, Math.max(s.min, x));
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Validate an untrusted kit; missing pads fall back to the default kit. */
function sanitizePadEq(raw: unknown): DrumPad['eq'] {
  if (!raw) return null;
  const e = sanitizeEffect(raw);
  return e && e.type === 'peq' ? e : null;
}

export function sanitizeKit(input: unknown): DrumKit {
  const d = defaultKit();
  const padsIn = Array.isArray(rec(input).pads) ? (rec(input).pads as unknown[]) : [];
  const pads = d.pads.map((def, i) => {
    const p = rec(padsIn[i]);
    if (!padsIn[i]) return def;
    const s = rec(p.source);
    let source: DrumPadSource = def.source;
    if (s.kind === 'sample' && typeof s.assetId === 'string') source = { kind: 'sample', assetId: s.assetId };
    if (s.kind === 'synth' && DRUM_VOICES.some((v) => v.type === s.voice)) {
      const models = DRUM_MODELS[s.voice as DrumVoiceType].length;
      const model = typeof s.model === 'number' && Number.isFinite(s.model) ? Math.min(models - 1, Math.max(0, Math.round(s.model))) : 0;
      source = { kind: 'synth', voice: s.voice as DrumVoiceType, tone: clamp(s.tone, DRUM_SPECS.tone), snap: clamp(s.snap, DRUM_SPECS.snap), length: clamp(s.length, DRUM_SPECS.length), model };
    }
    return {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 24) : def.name,
      source,
      gain: clamp(p.gain, DRUM_SPECS.gain),
      pan: clamp(p.pan, DRUM_SPECS.pan),
      tune: clamp(p.tune, DRUM_SPECS.tune),
      decay: clamp(p.decay, DRUM_SPECS.decay),
      choke: Math.min(DRUM_CHOKE_GROUPS, Math.max(0, Math.round(typeof p.choke === 'number' ? p.choke : 0))),
      eq: sanitizePadEq(p.eq),
      sends: [0, 1].map((j) => {
        const v = Array.isArray(p.sends) ? (p.sends as unknown[])[j] : 0;
        return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      }),
    } satisfies DrumPad;
  });
  return { pads };
}

/** Asset ids referenced by a kit (for persistence / missing-file checks). */
export function kitAssetIds(k: DrumKit): string[] {
  return k.pads.flatMap((p) => (p.source.kind === 'sample' ? [p.source.assetId] : []));
}
