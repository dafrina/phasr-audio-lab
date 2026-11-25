/**
 * Versioned, fully serializable project model.
 *
 * Rules:
 *  - Every timeline position/length is in integer ticks (960 PPQ).
 *  - Audio content offsets are in seconds of the source asset, because audio is
 *    not time-stretched: changing BPM moves clips but not their sound.
 *  - Raw audio never lives in the project; clips reference assets by ID.
 */
import type { KeysEngineType } from '../keys/params';
import type { ChordToolConfig } from '../chords/theory';
import type { TimeSignature } from '../core/time';
import type { TriOscPatch } from '../synth/params';

export const PROJECT_SCHEMA_VERSION = 1;
export const MAX_TRACKS = 8;
export const MAX_EFFECT_SLOTS = 4;

export type TrackKind = 'audio' | 'instrument';

export interface MidiNote {
  id: string;
  /** MIDI note number 0..127 */
  pitch: number;
  /** ticks, relative to the clip's content start */
  start: number;
  /** ticks */
  length: number;
  /** 1..127 */
  velocity: number;
}

interface ClipBase {
  id: string;
  trackId: string;
  name: string;
  /** Timeline position in ticks */
  start: number;
  /** Length on the timeline in ticks */
  length: number;
}

export interface MidiClip extends ClipBase {
  kind: 'midi';
  notes: MidiNote[];
  /**
   * Length of the repeating content in ticks. When the clip is longer than
   * this, the content loops. Equal to `length` for a non-looping clip.
   */
  loopLength: number;
  /** Whether content repeats when the clip is extended */
  loop: boolean;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  assetId: string;
  /** Seconds into the source asset where playback of this clip begins */
  sourceOffset: number;
  /** Linear gain 0..2 */
  gain: number;
  /** When true, the region [sourceOffset, sourceOffset + loopSeconds) repeats */
  loop: boolean;
  loopSeconds: number;
  /** When looping: seconds into the loop region at which the clip begins (for split clips) */
  loopStartPhase: number;
  /** Fade lengths in seconds */
  fadeIn: number;
  fadeOut: number;
}

export type Clip = MidiClip | AudioClip;

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export type DrumVoiceType =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'rim'
  | 'tom'
  | 'hatClosed'
  | 'hatOpen'
  | 'crash'
  | 'cowbell'
  | 'shaker'
  | 'perc'
  | 'zap';

/** Where a pad's sound comes from: the built-in drum synthesizer, or a sample asset. */
export type DrumPadSource =
  | { kind: 'synth'; voice: DrumVoiceType; tone: number; snap: number; length: number }
  | { kind: 'sample'; assetId: string };

export interface DrumPad {
  name: string;
  source: DrumPadSource;
  /** dB */
  gain: number;
  /** -1..1 */
  pan: number;
  /** semitones (changes playback rate) */
  tune: number;
  /** seconds the hit is allowed to ring before fading out */
  decay: number;
  /** 0 = none; pads sharing a group cut each other off (e.g. open/closed hat) */
  choke: number;
}

/** 16 pads; pad i plays MIDI note DRUM_BASE_NOTE + i. */
export interface DrumKit {
  pads: DrumPad[];
}

export type InstrumentConfig =
  | { type: 'triosc'; patch: TriOscPatch; presetName: string }
  | { type: 'drumrack'; kit: DrumKit; presetName: string }
  | { type: 'keys'; engine: KeysEngineType; params: Record<string, number>; presetName: string };

export type EffectType = 'eq' | 'peq' | 'compressor' | 'delay' | 'reverb' | 'chorus';

export interface EqParams {
  lowGain: number;
  midGain: number;
  highGain: number;
  midFreq: number;
}
export interface CompressorParams {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  makeup: number;
}
export interface DelayParams {
  time: number;
  feedback: number;
  mix: number;
  sync: boolean;
  /** Note division when synced, in quarter notes (e.g. 0.5 = 1/8) */
  division: number;
}
export type PeqBandType = 'bell' | 'lowshelf' | 'highshelf' | 'lowcut' | 'highcut' | 'notch' | 'bandpass';
export type PeqSlope = 12 | 24 | 48;

export interface PeqBand {
  enabled: boolean;
  type: PeqBandType;
  /** Hz */
  freq: number;
  /** dB (bell/shelves) */
  gain: number;
  /** bandwidth / resonance (linear Q) */
  q: number;
  /** dB/octave for low/high cut */
  slope: PeqSlope;
}

/** Parametric EQ: a fixed set of 8 band slots (disabled bands are transparent). */
export interface PeqParams {
  bands: PeqBand[];
  /** output gain in dB */
  output: number;
}

/** Chorus / flanger: modulated short delay. Flanger = short delay + feedback. */
export interface ChorusParams {
  /** LFO rate, Hz */
  rate: number;
  /** modulation depth, seconds */
  depth: number;
  /** base delay, seconds */
  delay: number;
  /** -0.95..0.95 (negative = inverted feedback for hollow flanging) */
  feedback: number;
  mix: number;
  /** stereo LFO phase spread, 0..1 = 0..180° */
  width: number;
}

export interface ReverbParams {
  decay: number;
  preDelay: number;
  mix: number;
}

export type EffectSlot =
  | { id: string; enabled: boolean; type: 'eq'; params: EqParams }
  | { id: string; enabled: boolean; type: 'compressor'; params: CompressorParams }
  | { id: string; enabled: boolean; type: 'delay'; params: DelayParams }
  | { id: string; enabled: boolean; type: 'reverb'; params: ReverbParams }
  | { id: string; enabled: boolean; type: 'peq'; params: PeqParams }
  | { id: string; enabled: boolean; type: 'chorus'; params: ChorusParams };

/** What an automation lane controls. Effect params use a key like 'lowGain' or 'b3.freq'. */
export type AutomationTarget =
  | { kind: 'track'; param: 'volumeDb' | 'pan' }
  | { kind: 'fx'; slotId: string; param: string }
  /** an instrument parameter, e.g. TriOsc 'ampEnv.release' or drum pad 'p0.tune' */
  | { kind: 'inst'; param: string };

export interface AutomationPoint {
  id: string;
  /** timeline ticks */
  tick: number;
  /** value in the parameter's own units (dB, Hz, 0..1, …) */
  value: number;
}

/**
 * A modulation (sidechain) route: a signal derived from another track drives
 * a parameter on the track that owns the route, on top of its static or
 * automated value.
 *  - 'audio': envelope follower on the source track's post-effects signal
 *  - 'midi':  an attack/hold/release envelope fired by the source's note-ons
 */
export type ModSourceKind = 'audio' | 'midi';

export interface ModRoute {
  id: string;
  sourceTrackId: string;
  source: ModSourceKind;
  target: AutomationTarget;
  /** maximum offset in the target's modulation units (dB, semitones, …); negative ducks */
  depth: number;
  /** seconds */
  attack: number;
  /** seconds */
  release: number;
  /** audio: level (dBFS) above which the envelope starts to open */
  threshold: number;
  /** midi: seconds the envelope stays fully open after a note-on */
  hold: number;
  /** midi: only this note number triggers (null = any note), e.g. the kick pad of a drum rack */
  note: number | null;
  /** flip the envelope (modulate when the source is quiet) */
  invert: boolean;
  enabled: boolean;
}

export interface AutomationLane {
  id: string;
  target: AutomationTarget;
  /** sorted by tick; linear interpolation between points */
  points: AutomationPoint[];
  enabled: boolean;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  kind: TrackKind;
  /** Fader level in dB (-60 = -inf, max +6) */
  volumeDb: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  armed: boolean;
  monitor: boolean;
  /** Present for instrument tracks */
  instrument: InstrumentConfig | null;
  effects: EffectSlot[];
  automation: AutomationLane[];
  modulations: ModRoute[];
  /** Gucci Slipper-izer chord tool (instrument tracks); clips keep the single played notes */
  chords?: ChordToolConfig | null;
}

export interface AssetRef {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  frames: number;
}

export interface LoopRegion {
  enabled: boolean;
  start: number;
  end: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  tracks: Track[];
  clips: Record<string, Clip>;
  master: { volumeDb: number; limiter: boolean };
  loop: LoopRegion;
  metronome: boolean;
  countInBars: number;
  assets: Record<string, AssetRef>;
  createdAt: number;
  updatedAt: number;
}
