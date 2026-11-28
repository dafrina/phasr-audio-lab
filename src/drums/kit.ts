/**
 * Drum rack kit model: pad layout, factory kits and validation (pure).
 * Pad i is played by MIDI note DRUM_BASE_NOTE + i (36 = C1, the General MIDI kick);
 * the factory kits put their sounds on the General MIDI keys (see `kit()`).
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

/** Every built-in voice comes in these styles (index = model; 0 = the classic sound), chosen per pad. */
export const DRUM_STYLES = ['Classic', 'House', 'Techno', 'Hip-Hop', 'Trap', 'Lo-Fi'] as const;
/** What each style is, per voice (tooltips). */
export const DRUM_MODELS: Record<DrumVoiceType, string[]> = {
  kick: ['Classic · tight, clicky', 'House · 909 punch', 'Techno · driven boom', 'Hip-Hop · round thump + knock', 'Trap · 808 sub', 'Lo-Fi · 12-bit sampler'],
  snare: ['Classic · crisp', 'House · 909', 'Techno · gated, metal ring', 'Hip-Hop · fat, warm', 'Trap · crack + clap', 'Lo-Fi · 12-bit sampler'],
  clap: ['Classic', 'House · 909 roomy', 'Techno · tight snap', 'Hip-Hop · thick layered', 'Trap · tight bright', 'Lo-Fi · 12-bit sampler'],
  rim: ['Classic · 808 rim', 'House · 909 rim', 'Techno · click', 'Hip-Hop · wood knock', 'Trap · high tick', 'Lo-Fi · 12-bit sampler'],
  tom: ['Classic', 'House · 909 tom', 'Techno · electronic sweep', 'Hip-Hop · warm floor tom', 'Trap · 808 tom', 'Lo-Fi · 12-bit sampler'],
  hatClosed: ['Classic · metal + noise', 'House · crisp noise', 'Techno · hard metal', 'Hip-Hop · dark, dusty', 'Trap · 808 metal (for rolls)', 'Lo-Fi · 12-bit sampler'],
  hatOpen: ['Classic · metal + noise', 'House · crisp noise', 'Techno · hard metal', 'Hip-Hop · dark, dusty', 'Trap · 808 metal', 'Lo-Fi · 12-bit sampler'],
  crash: ['Classic', 'House · ride', 'Techno · reverse crash', 'Hip-Hop · dark trashy crash', 'Trap · bright splash', 'Lo-Fi · 12-bit sampler'],
  cowbell: ['Classic · 808 bell', 'House · tight bell', 'Techno · big bell', 'Hip-Hop · dark bell', 'Trap · 808 bell', 'Lo-Fi · 12-bit sampler'],
  shaker: ['Classic', 'House · soft egg', 'Techno · tight', 'Hip-Hop · dusty', 'Trap · crisp short', 'Lo-Fi · 12-bit sampler'],
  perc: ['Classic · FM blip', 'House · bongo', 'Techno · metal ping', 'Hip-Hop · wood knock', 'Trap · water drop', 'Lo-Fi · 12-bit sampler'],
  zap: ['Classic · dive', 'House · laser', 'Techno · noise sweep', 'Hip-Hop · vinyl scratch', 'Trap · rising swoosh', 'Lo-Fi · 12-bit sampler'],
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

/**
 * Pad gains (dB) of the factory kits, measured so that every kit's kick, snare, clap, hats …
 * land at the same loudness and every kit plays a beat at the same level with headroom
 * (tests/drumQuality.test.ts checks both: re-measure them there after changing a voice).
 */
const VARIANT_GAINS = {
  electro: [-1.5, -6.5, -3, -2.5, -0.5, -3, -8, 0.5, -10, -3, -8.5, -9.5, -2.5, -10, -12, -7.5],
  punchy: [-1, -6.5, -2, -2.5, -0.5, -3, -8, 0.5, -10, -3, -8.5, -9.5, -2.5, -10, -12, -7.5],
  lofi: [-1, -7.5, -3, -5, -1.5, -4.5, -5, -1.5, -9.5, -4.5, -9, -9.5, -4, -10, -12.5, -9.5],
};

/**
 * Pads on consecutive notes 36–51 (C1–D#2, what 16-pad controllers send), laid out like
 * General MIDI: kick 36, side stick 37, snare 38, clap 39, a second snare 40, toms on GM tom
 * keys (41 / 45 / 48), closed hat 42 and open hat 46 (one choke group), crash 49. GM puts
 * this kit's other sounds (a second kick, shaker, perc, zap, cowbell) outside 36–51, so they
 * fill the keys left over (43, 44, 47, 50, 51); MIDI files carry them on their GM keys
 * instead (see gm.ts). Every factory kit follows the same plan.
 */
function kit(variant: 'electro' | 'punchy' | 'lofi'): DrumKit {
  const v = { electro: 0.5, punchy: 0.7, lofi: 0.3 }[variant];
  const pads: DrumPad[] = [
    pad('Kick', synth('kick', 0.45 * v + 0.2, 0.6, variant === 'electro' ? 0.7 : 0.45)),
    pad('Rim', synth('rim', 0.5, 0.6, 0.06)),
    pad('Snare', synth('snare', 0.5, 0.5 + v * 0.3, 0.28)),
    pad('Clap', synth('clap', 0.5, 0.6, 0.35)),
    pad('Snare Tight', synth('snare', 0.7, 0.8, 0.14)),
    pad('Tom Low', synth('tom', 0.2, 0.4, 0.45), { pan: -0.25 }),
    pad('Closed Hat', synth('hatClosed', 0.6, 0.6, 0.06), { choke: 1 }),
    pad('Kick Short', synth('kick', 0.6, 0.8, 0.22)),
    pad('Shaker', synth('shaker', 0.6, 0.4, 0.12), { pan: 0.35 }),
    pad('Tom Mid', synth('tom', 0.45, 0.4, 0.4), { pan: 0.05 }),
    pad('Open Hat', synth('hatOpen', 0.6, 0.5, 0.55), { choke: 1 }),
    pad('Perc', synth('perc', 0.5, 0.5, 0.18), { pan: -0.3 }),
    pad('Tom High', synth('tom', 0.7, 0.4, 0.35), { pan: 0.3 }),
    pad('Crash', synth('crash', 0.5, 0.5, 1.8)),
    pad('Zap', synth('zap', 0.5, 0.5, 0.25)),
    pad('Cowbell', synth('cowbell', 0.5, 0.5, 0.3)),
  ];
  pads.forEach((p, i) => (p.gain = VARIANT_GAINS[variant][i] as number));
  if (variant === 'lofi') {
    // the Lo-Fi style on every pad, tuned down a little
    for (const p of pads) {
      p.tune = -2;
      if (p.source.kind === 'synth') p.source = { ...p.source, model: 5 };
    }
  }
  return { pads };
}

const H = 1;
const T = 2;
const HH = 3;
/** One kit per style, built from the House / Techno / Hip-Hop voices. */
function kitHouse(): DrumKit {
  return {
    pads: [
      pad('Kick House', synth('kick', 0.45, 0.6, 0.5, H), { gain: -1 }),
      pad('Rim House', synth('rim', 0.5, 0.6, 0.05, H), { gain: -1.5 }),
      pad('Snare House', synth('snare', 0.5, 0.6, 0.25, H), { gain: -2.5 }),
      pad('Clap House', synth('clap', 0.5, 0.6, 0.35, H), { gain: -4 }),
      pad('Clap Tight', synth('clap', 0.6, 0.5, 0.15, T), { gain: 1.5 }),
      pad('Tom Low', synth('tom', 0.2, 0.4, 0.45, H), { gain: -3, pan: -0.25 }),
      pad('Closed Hat', synth('hatClosed', 0.6, 0.5, 0.05, H), { gain: -5.5, choke: 1 }),
      pad('Kick Short', synth('kick', 0.55, 0.8, 0.25, H), { gain: 0.5 }),
      pad('Shaker Soft', synth('shaker', 0.5, 0.5, 0.2, H), { gain: -13, pan: 0.35 }),
      pad('Tom Mid', synth('tom', 0.45, 0.4, 0.4, H), { gain: -2.5, pan: 0.05 }),
      pad('Open Hat', synth('hatOpen', 0.6, 0.5, 0.45, H), { gain: -10.5, choke: 1 }),
      pad('Bongo', synth('perc', 0.4, 0.5, 0.2, H), { gain: -6.5, pan: -0.3 }),
      pad('Tom High', synth('tom', 0.7, 0.4, 0.35, H), { gain: -2, pan: 0.3 }),
      pad('Cowbell', synth('cowbell', 0.5, 0.5, 0.15, H), { gain: -4.5 }),
      pad('Laser', synth('zap', 0.5, 0.5, 0.25, H), { gain: -11 }),
      pad('Ride', synth('crash', 0.5, 0.5, 1.6, H), { gain: -7.5 }),
    ],
  };
}
function kitTechno(): DrumKit {
  return {
    pads: [
      pad('Kick Techno', synth('kick', 0.35, 0.6, 0.6, T), { gain: 0.5 }),
      pad('Click', synth('rim', 0.7, 0.4, 0.05, T), { gain: -1 }),
      pad('Snare Techno', synth('snare', 0.5, 0.6, 0.18, T)),
      pad('Clap House', synth('clap', 0.55, 0.6, 0.4, H), { gain: -4 }),
      pad('Snare House', synth('snare', 0.65, 0.8, 0.18, H), { gain: -1.5 }),
      pad('Tom Electronic', synth('tom', 0.25, 0.6, 0.4, T), { gain: -2, pan: -0.25 }),
      pad('Hat Metal', synth('hatClosed', 0.65, 0.5, 0.05, T), { gain: -2, choke: 1 }),
      pad('Kick Rumble', synth('kick', 0.25, 0.4, 1.2, T), { gain: -4 }),
      pad('Shaker Tight', synth('shaker', 0.8, 0.7, 0.06, T), { gain: -7.5, pan: 0.35 }),
      pad('Metal Ping', synth('perc', 0.4, 0.6, 0.3, T), { gain: -5, pan: 0.2 }),
      pad('Open Hat Metal', synth('hatOpen', 0.65, 0.5, 0.4, T), { gain: -5.5, choke: 1 }),
      pad('Big Bell', synth('cowbell', 0.5, 0.5, 0.48, T), { gain: -9, pan: -0.3 }),
      pad('Tom Electronic Hi', synth('tom', 0.6, 0.6, 0.3, T), { gain: -0.5, pan: 0.3 }),
      pad('Reverse Crash', synth('crash', 0.5, 0.6, 1.2, T), { gain: -17 }),
      pad('Zap', synth('zap', 0.5, 0.5, 0.25), { gain: -12 }),
      pad('Noise Sweep', synth('zap', 0.5, 0.4, 0.8, T), { gain: -12.5 }),
    ],
  };
}
function kitHipHop(): DrumKit {
  return {
    pads: [
      pad('Kick Boom-Bap', synth('kick', 0.45, 0.6, 0.45, HH), { gain: 1 }),
      pad('Rim Wood', synth('rim', 0.4, 0.5, 0.08, HH), { gain: -5 }),
      pad('Snare Crack', synth('snare', 0.5, 0.6, 0.25, HH), { gain: -0.5 }),
      pad('Clap Thick', synth('clap', 0.45, 0.6, 0.3, HH), { gain: -2 }),
      pad('Snare Trap', synth('snare', 0.7, 0.8, 0.14, 4)),
      pad('Floor Tom', synth('tom', 0.2, 0.4, 0.5, HH), { gain: -3, pan: -0.25 }),
      pad('Closed Hat', synth('hatClosed', 0.5, 0.5, 0.05, HH), { gain: -7, choke: 1 }),
      pad('Kick Short', synth('kick', 0.55, 0.8, 0.25, HH), { gain: 2 }),
      pad('Hat Fast', synth('hatClosed', 0.65, 0.6, 0.03, HH), { gain: -6, choke: 1 }),
      pad('Tom Mid', synth('tom', 0.5, 0.4, 0.4, HH), { gain: -2.5, pan: 0.05 }),
      pad('Open Hat', synth('hatOpen', 0.5, 0.5, 0.4, HH), { gain: -9, choke: 1 }),
      pad('Knock', synth('perc', 0.45, 0.5, 0.12, HH), { gain: -3, pan: -0.3 }),
      pad('Scratch', synth('zap', 0.5, 0.5, 0.35, HH), { gain: -10.5, pan: 0.3 }),
      pad('Crash Dark', synth('crash', 0.5, 0.5, 1.4, HH), { gain: -8.5 }),
      pad('Shaker Dusty', synth('shaker', 0.5, 0.5, 0.15, HH), { gain: -10.5, pan: 0.35 }),
      pad('Lo-fi Bell', synth('cowbell', 0.5, 0.5, 0.25, HH), { gain: -6.5 }),
    ],
  };
}

function kitTrap(): DrumKit {
  const TR = 4;
  return {
    pads: [
      pad('808 Kick', synth('kick', 0.4, 0.5, 0.9, TR), { gain: -2, choke: 2 }),
      pad('Rim Tick', synth('rim', 0.6, 0.6, 0.04, TR), { gain: -5.5 }),
      pad('Snare Trap', synth('snare', 0.6, 0.7, 0.22, TR)),
      pad('Clap Trap', synth('clap', 0.6, 0.6, 0.3, TR), { gain: -1 }),
      pad('Snare Boom-Bap', synth('snare', 0.5, 0.6, 0.25, 3), { gain: -2 }),
      pad('808 Tom Low', synth('tom', 0.2, 0.4, 0.5, TR), { gain: -5.5, pan: -0.25 }),
      pad('Hat 808', synth('hatClosed', 0.65, 0.5, 0.05, TR), { gain: -0.5, choke: 1 }),
      pad('808 Kick Long', synth('kick', 0.3, 0.4, 1.6, TR), { gain: -3.5, choke: 2 }),
      pad('Shaker Crisp', synth('shaker', 0.7, 0.6, 0.06, TR), { gain: -8, pan: 0.35 }),
      pad('808 Tom Mid', synth('tom', 0.45, 0.4, 0.45, TR), { gain: -5.5, pan: 0.05 }),
      pad('Open Hat 808', synth('hatOpen', 0.65, 0.5, 0.35, TR), { gain: -3, choke: 1 }),
      pad('Water Drop', synth('perc', 0.5, 0.5, 0.12, TR), { gain: -6, pan: -0.3 }),
      pad('808 Tom High', synth('tom', 0.7, 0.4, 0.4, TR), { gain: -5, pan: 0.3 }),
      pad('Crash Splash', synth('crash', 0.5, 0.5, 1.4, TR), { gain: -9 }),
      pad('Swoosh', synth('zap', 0.5, 0.5, 0.6, TR), { gain: -15.5 }),
      pad('808 Bell', synth('cowbell', 0.5, 0.5, 0.36, TR), { gain: -8.5 }),
    ],
  };
}

export const FACTORY_KITS: { name: string; kit: DrumKit }[] = [
  { name: 'Electro Kit', kit: kit('electro') },
  { name: 'Punchy Kit', kit: kit('punchy') },
  { name: 'Lo-Fi Kit', kit: kit('lofi') },
  { name: 'House Kit', kit: kitHouse() },
  { name: 'Techno Kit', kit: kitTechno() },
  { name: 'Hip-Hop Kit', kit: kitHipHop() },
  { name: 'Trap Kit', kit: kitTrap() },
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
