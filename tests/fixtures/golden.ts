/**
 * The golden reference project: a deliberately busy, fully deterministic
 * arrangement that touches every subsystem, built with the app's own
 * factories (real schema) and generated audio (no sample libraries).
 *
 *  1 Drums      Drum Rack: kick / snare / closed hats, open hats the next closed hat chokes, a 1-bar looping clip, pad send
 *  2 808 Seq    Keyforge 808 through the Arp-Ape-ator (sequencer: ties, chance, slide, roll)
 *  3 TriOsc     automated cutoff, resonance and oscillator level
 *  4 Grand      Keyforge piano: chords, long notes and release tails
 *  5 Sampler    two generated zones (velocity layers)
 *  6 Audio      a generated loop: source offset, fades, gain, a trimmed second clip that overlaps
 *  7 Chords     Gucci Slipper-izer on an electric piano
 *  8 Pad        Keyforge Analog pad (built-in delay / space) with Reverb Lite
 *  9 Muted      a loud track that is muted, sends up (must not be heard, also not via its sends)
 * 10 Drive      TriOsc lead → Utility → Saturator (split, emphasis, Lo-Fi) → Phaser
 * 11 Organ      tonewheel organ ducked by the kick (MIDI sidechain) and an auto-filter swept by the drums' audio
 * 12 Arp        TriOsc through the arpeggiator (up-down, 2 octaves), chorus + delay
 *
 * Master: Spectra EQ + compressor. Send A: Reverb Pro (default), Send B: delay.
 * Every id and timestamp is fixed, so the project serialises identically each time.
 */
import { createProject, createTrack, createMidiClip, createAudioClip } from '../../src/project/defaults';
import { createEffectSlot } from '../../src/audio/effects/specs';
import { createRoute } from '../../src/project/modulation';
import { defaultArp } from '../../src/arp/arp';
import { defaultChordTool } from '../../src/chords/theory';
import { INSTRUMENTS } from '../../src/instruments/definitions';
import { KEYS_PRESETS } from '../../src/keys/presets';
import { FACTORY_PRESETS } from '../../src/synth/presets';
import { encodeWav } from '../../src/audio/wav';
import { PPQ } from '../../src/core/time';
import type { AssetRef, EffectSlot, InstrumentConfig, MidiNote, Project, Track } from '../../src/project/types';

export const GOLDEN_BARS = 4;
export const GOLDEN_BPM = 120;
const BAR = PPQ * 4;
const SR = 44100;

export interface GoldenAsset {
  ref: AssetRef;
  mime: string;
  bytes: ArrayBuffer;
  channels: Float32Array[];
}

/** a decaying harmonic tone (a plucked C4 by default), deterministic */
function pluck(seconds: number, freq: number, level: number): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 3.2);
    out[i] = level * env * (Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(4 * Math.PI * freq * t) + 0.15 * Math.sin(6 * Math.PI * freq * t));
  }
  return out;
}

/** a 2-second stereo loop: noise hits on the beats (seeded) over a sine bass */
function loop(): Float32Array[] {
  const n = 2 * SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let s = 0x2545f491;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s | 0) / 2147483648;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = t % 0.5;
    const hit = Math.exp(-beat * 40) * rnd() * 0.5;
    const bass = 0.3 * Math.sin(2 * Math.PI * 55 * t) * (0.6 + 0.4 * Math.cos(2 * Math.PI * 0.5 * t));
    L[i] = bass + hit;
    R[i] = bass + hit * 0.7;
  }
  return [L, R];
}

function asset(id: string, name: string, channels: Float32Array[]): GoldenAsset {
  const frames = channels[0]!.length;
  return {
    ref: { id, name, sampleRate: SR, channels: channels.length, durationSec: frames / SR, frames },
    mime: 'audio/wav',
    bytes: encodeWav(channels, SR, { format: 'float32' }),
    channels,
  };
}

/** the generated audio files the project uses */
export function goldenAssets(): GoldenAsset[] {
  return [asset('gold-pluck-loud', 'pluck-C4-loud.wav', [pluck(1.5, 261.63, 0.8)]), asset('gold-pluck-soft', 'pluck-C4-soft.wav', [pluck(1.5, 261.63, 0.3)]), asset('gold-loop', 'loop-2s.wav', loop())];
}

const keysPreset = (name: string): InstrumentConfig => {
  const p = KEYS_PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no Keyforge preset ${name}`);
  return { type: 'keys', engine: p.engine, params: { ...p.params }, presetName: p.name };
};
const triosc = (name: string): InstrumentConfig => {
  const p = FACTORY_PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no TriOsc preset ${name}`);
  return { type: 'triosc', patch: structuredClone(p.patch), presetName: p.name };
};
const fx = (type: EffectSlot['type'], id: string, params: Record<string, unknown> = {}): EffectSlot => {
  const s = createEffectSlot(type);
  return { ...s, id, params: { ...s.params, ...params } } as EffectSlot;
};

export function buildGoldenProject(): Project {
  const p = createProject('Golden reference');
  p.id = 'golden-project';
  p.createdAt = 1_700_000_000_000;
  p.updatedAt = 1_700_000_000_000;
  p.bpm = GOLDEN_BPM;
  p.metronome = false;
  p.countInBars = 0;
  p.loop = { enabled: false, start: BAR, end: 3 * BAR };
  for (const a of goldenAssets()) p.assets[a.ref.id] = a.ref;

  const tracks: Track[] = [];
  const add = (n: number, name: string, kind: 'audio' | 'instrument', inst?: InstrumentConfig) => {
    const t = createTrack(kind, n - 1, inst);
    t.id = `gold-t${n}`;
    t.name = name;
    t.volumeDb = -12;
    tracks.push(t);
    return t;
  };
  const clips: Project['clips'] = {};
  const midi = (t: Track, id: string, start: number, length: number, notes: Omit<MidiNote, 'id'>[], loop?: number) => {
    const c = createMidiClip(t.id, start, length);
    c.id = id;
    c.name = id;
    c.notes = notes.map((n, i) => ({ ...n, id: `${id}-n${i}` }));
    if (loop) {
      c.loop = true;
      c.loopLength = loop;
    }
    clips[c.id] = c;
    return c;
  };
  const S16 = PPQ / 4;

  // 1 Drums: a one-bar pattern looping over the song
  const drums = add(1, 'Drums', 'instrument', INSTRUMENTS.drumrack.createConfig());
  drums.sends = [0.25, 0];
  const dn: Omit<MidiNote, 'id'>[] = [];
  for (let s = 0; s < 16; s++) {
    if (s % 4 === 0) dn.push({ pitch: 36, start: s * S16, length: 120, velocity: 118 });
    if (s === 4 || s === 12) dn.push({ pitch: 38, start: s * S16, length: 120, velocity: 110 });
    if (s % 2 === 1) dn.push({ pitch: 42, start: s * S16, length: 60, velocity: s % 4 === 3 ? 96 : 70 }); // GM closed hat
    // GM open hat (0.55 s long) a 16th before a closed hat of its choke group, which cuts it
    if (s === 6 || s === 14) dn.push({ pitch: 46, start: s * S16, length: 60, velocity: 90 });
  }
  midi(drums, 'gold-c-drums', 0, GOLDEN_BARS * BAR, dn, BAR);

  // 2 808 through the step sequencer (ties, chance, slide, roll)
  const bass = add(2, '808 Seq', 'instrument', keysPreset('Trap 808'));
  const arp = defaultArp();
  bass.arp = {
    ...arp,
    mode: 'seq',
    rate: 0.25,
    length: 8,
    gate: 0.6,
    steps: arp.steps.map((s, i) => ({
      ...s,
      on: [0, 1, 3, 4, 6, 7].includes(i),
      tie: i === 0 || i === 6,
      prob: i === 3 ? 0.5 : 1,
      slide: i === 4,
      ratchet: i === 7 ? 2 : 1,
      transpose: i === 4 ? 7 : i === 6 ? -2 : 0,
    })),
    presetName: 'Golden',
  };
  midi(bass, 'gold-c-808', 0, GOLDEN_BARS * BAR, [
    { pitch: 36, start: 0, length: 2 * BAR, velocity: 100 },
    { pitch: 41, start: 2 * BAR, length: 2 * BAR, velocity: 100 },
  ]);

  // 3 TriOsc with automation (cutoff, resonance, oscillator 2 level)
  const lead = add(3, 'TriOsc', 'instrument', triosc('Detuned Saw'));
  midi(lead, 'gold-c-tri', 0, GOLDEN_BARS * BAR, [0, 1, 2, 3].map((b) => ({ pitch: 57 + b * 2, start: b * BAR, length: BAR - S16, velocity: 90 })));
  lead.automation = [
    { id: 'gold-a-cut', target: { kind: 'inst', param: 'filter.cutoff' }, enabled: true, points: [{ id: 'p1', tick: 0, value: 300 }, { id: 'p2', tick: 2 * BAR, value: 6000 }, { id: 'p3', tick: 4 * BAR, value: 800 }] },
    { id: 'gold-a-res', target: { kind: 'inst', param: 'filter.resonance' }, enabled: true, points: [{ id: 'p1', tick: BAR, value: 0.1 }, { id: 'p2', tick: 3 * BAR, value: 0.7 }] },
    { id: 'gold-a-vol', target: { kind: 'track', param: 'volumeDb' }, enabled: true, points: [{ id: 'p1', tick: 0, value: -18 }, { id: 'p2', tick: BAR, value: -10 }, { id: 'p3', tick: BAR, value: -14 }] },
  ];

  // 4 Grand piano: chords, a long held note, release tails
  const grand = add(4, 'Grand', 'instrument', keysPreset('Concert Grand'));
  midi(grand, 'gold-c-grand', 0, GOLDEN_BARS * BAR, [
    ...[48, 55, 60, 64].map((pitch) => ({ pitch, start: 0, length: BAR, velocity: 84 })),
    ...[45, 52, 57, 60].map((pitch) => ({ pitch, start: BAR, length: PPQ / 2, velocity: 100 })),
    { pitch: 72, start: 2 * BAR, length: 2 * BAR, velocity: 70 },
    { pitch: 76, start: 2 * BAR + PPQ, length: PPQ / 4, velocity: 120 },
    // the same pitch ending where the next one starts
    { pitch: 79, start: 3 * BAR, length: PPQ, velocity: 90 },
    { pitch: 79, start: 3 * BAR + PPQ, length: PPQ, velocity: 60 },
  ]);

  // 5 Sampler: two velocity layers of a generated pluck
  const samp = INSTRUMENTS.sampler.createConfig();
  if (samp.type === 'sampler') {
    samp.zones = [
      { id: 'gold-z-soft', assetId: 'gold-pluck-soft', name: 'soft', root: 60, lo: 0, hi: 127, velLo: 1, velHi: 80, tune: 0, gain: 0, loudness: -22 },
      { id: 'gold-z-loud', assetId: 'gold-pluck-loud', name: 'loud', root: 60, lo: 0, hi: 127, velLo: 81, velHi: 127, tune: 0, gain: 0, loudness: -13 },
    ];
    samp.autoMap = false;
    samp.presetName = 'Golden plucks';
  }
  const sampler = add(5, 'Sampler', 'instrument', samp);
  midi(sampler, 'gold-c-samp', 0, GOLDEN_BARS * BAR, [
    { pitch: 60, start: 0, length: PPQ, velocity: 50 },
    { pitch: 60, start: PPQ, length: PPQ, velocity: 120 },
    { pitch: 67, start: 2 * PPQ, length: PPQ, velocity: 100 },
    { pitch: 48, start: 3 * PPQ, length: 2 * PPQ, velocity: 64 },
  ], BAR);

  // 6 Audio: source offset, fades, gain; a trimmed second clip that overlaps the first
  const audio = add(6, 'Audio', 'audio');
  const a1 = createAudioClip(audio.id, 'gold-loop', 'loop A', 0, 2 * BAR);
  a1.id = 'gold-c-audio1';
  a1.sourceOffset = 0.25;
  a1.gain = 0.8;
  a1.fadeIn = 0.05;
  a1.fadeOut = 0.3;
  a1.loop = true;
  a1.loopSeconds = 1.5;
  const a2 = createAudioClip(audio.id, 'gold-loop', 'loop B', 2 * BAR - PPQ, BAR + PPQ);
  a2.id = 'gold-c-audio2';
  a2.sourceOffset = 1;
  a2.gain = 1.2;
  a2.fadeIn = 0.01;
  clips[a1.id] = a1;
  clips[a2.id] = a2;

  // 7 Slipper-izer on an electric piano: single keys → chords
  const chords = add(7, 'Chords', 'instrument', keysPreset('Classic Tine EP'));
  chords.chords = { ...defaultChordTool('deephouse') };
  midi(chords, 'gold-c-chords', 0, GOLDEN_BARS * BAR, [60, 62, 64, 65].map((pitch, b) => ({ pitch, start: b * BAR, length: BAR / 2, velocity: 96 })));

  // 8 Analog pad with Reverb Lite
  const pad = add(8, 'Pad', 'instrument', keysPreset('Warm Pad'));
  pad.effects = [fx('room', 'gold-fx-room', { decay: 2.4, mix: 0.3 })];
  midi(pad, 'gold-c-pad', 0, GOLDEN_BARS * BAR, [48, 55, 63].map((pitch) => ({ pitch, start: 0, length: 3 * BAR, velocity: 80 })));

  // 9 Muted: loud, must not be heard
  const muted = add(9, 'Muted', 'instrument', triosc('Detuned Saw'));
  muted.mute = true;
  muted.volumeDb = 0;
  // sends up: muting must silence what it sends to the send channels too
  muted.sends = [0.8, 0.8];
  midi(muted, 'gold-c-muted', 0, GOLDEN_BARS * BAR, [{ pitch: 84, start: 0, length: GOLDEN_BARS * BAR, velocity: 127 }]);

  // 10 Drive chain
  const drive = add(10, 'Drive', 'instrument', triosc('Detuned Saw'));
  drive.effects = [
    fx('utility', 'gold-fx-util', { gain: -3, width: 1.3 }),
    fx('saturator', 'gold-fx-sat', { mode: 'overdrive', drive: 18, clean: 120, focus: 900, emph: 6, bits: 10, rate: 16000, tone: 8000 }),
    fx('phaser', 'gold-fx-ph', { mix: 0.4 }),
  ];
  drive.sends = [0, 0.3];
  midi(drive, 'gold-c-drive', BAR, 2 * BAR, [64, 67, 71, 74, 71, 67].map((pitch, i) => ({ pitch, start: i * PPQ, length: PPQ / 2, velocity: 100 })));

  // 11 Organ: ducked by the kick (MIDI) and an auto-filter swept by the drums' audio
  const organ = add(11, 'Organ', 'instrument', keysPreset('Jazz Tonewheel'));
  organ.effects = [fx('autofilter', 'gold-fx-af', { cutoff: 1200, mix: 1 })];
  midi(organ, 'gold-c-organ', 0, GOLDEN_BARS * BAR, [53, 57, 60].map((pitch) => ({ pitch, start: 0, length: GOLDEN_BARS * BAR, velocity: 90 })));

  // 12 Arpeggiator on TriOsc with chorus and delay
  const arpT = add(12, 'Arp', 'instrument', triosc('Init Sine'));
  arpT.arp = { ...defaultArp(), mode: 'arp', direction: 'updown', octaves: 2, rate: 0.25, presetName: 'Golden arp' };
  arpT.effects = [fx('chorus', 'gold-fx-ch'), fx('delay', 'gold-fx-dl', { sync: true, division: 0.75, feedback: 0.4, mix: 0.25 })];
  midi(arpT, 'gold-c-arp', 2 * BAR, 2 * BAR, [60, 64, 67].map((pitch) => ({ pitch, start: 0, length: 2 * BAR, velocity: 90 })));

  p.tracks = tracks;
  p.clips = clips;

  // sidechains (made through the app's own route factory)
  const duck = createRoute(organ, drums.id, 'midi', { kind: 'track', param: 'volumeDb' });
  const sweep = createRoute(organ, drums.id, 'audio', { kind: 'fx', slotId: 'gold-fx-af', param: 'cutoff' });
  if (!duck || !sweep) throw new Error('golden: sidechain routes refused');
  organ.modulations = [
    { ...duck, id: 'gold-m-duck', note: 36, depth: -12 },
    { ...sweep, id: 'gold-m-sweep', depth: 2 },
  ];

  // master and send channels
  p.master.effects = [
    fx('peq', 'gold-fx-mpeq'),
    fx('compressor', 'gold-fx-mcomp', { threshold: -20, ratio: 3, attack: 0.01, release: 0.2, makeup: 2 }),
  ];
  p.sends = p.sends.map((b, k) => ({ ...b, effects: b.effects.map((e, j) => ({ ...e, id: `gold-fx-send${k}-${j}` })) }));
  return p;
}
