/**
 * Musical time representation.
 *
 * All positions in the project are stored as integer ticks at a fixed
 * resolution of 960 pulses per quarter note (PPQ). A "beat" is one quarter
 * note regardless of the time-signature denominator; the bar length is derived
 * from the time signature (numerator × (4 / denominator) quarter notes).
 *
 * The project uses a single constant tempo, so tick ↔ seconds conversion is a
 * linear mapping. Transport code that needs to deal with loop wraps keeps its
 * own (contextTime, tick) anchors on top of these functions.
 */

export const PPQ = 960;

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface BarsBeatsTicks {
  /** 1-based bar number */
  bar: number;
  /** 1-based beat within the bar (in time-signature beat units) */
  beat: number;
  /** ticks within the beat, 0-based */
  tick: number;
}

export function ticksPerBeatUnit(ts: TimeSignature): number {
  // A beat in a 6/8 bar is an eighth note = PPQ / 2.
  return (PPQ * 4) / ts.denominator;
}

export function ticksPerBar(ts: TimeSignature): number {
  return ticksPerBeatUnit(ts) * ts.numerator;
}

export function secondsPerTick(bpm: number): number {
  return 60 / (bpm * PPQ);
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return ticks * secondsPerTick(bpm);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds * bpm * PPQ) / 60;
}

export function ticksToBeats(ticks: number): number {
  return ticks / PPQ;
}

export function beatsToTicks(beats: number): number {
  return beats * PPQ;
}

export function ticksToBars(ticks: number, ts: TimeSignature): number {
  return ticks / ticksPerBar(ts);
}

export function barsToTicks(bars: number, ts: TimeSignature): number {
  return bars * ticksPerBar(ts);
}

export function secondsToSamples(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

export function samplesToSeconds(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

export function ticksToSamples(ticks: number, bpm: number, sampleRate: number): number {
  return secondsToSamples(ticksToSeconds(ticks, bpm), sampleRate);
}

export function samplesToTicks(samples: number, bpm: number, sampleRate: number): number {
  return secondsToTicks(samplesToSeconds(samples, sampleRate), bpm);
}

export function ticksToBBT(ticks: number, ts: TimeSignature): BarsBeatsTicks {
  const t = Math.max(0, Math.floor(ticks));
  const perBar = ticksPerBar(ts);
  const perBeat = ticksPerBeatUnit(ts);
  const bar = Math.floor(t / perBar);
  const inBar = t - bar * perBar;
  const beat = Math.floor(inBar / perBeat);
  const tick = inBar - beat * perBeat;
  return { bar: bar + 1, beat: beat + 1, tick };
}

export function bbtToTicks(bbt: BarsBeatsTicks, ts: TimeSignature): number {
  return (bbt.bar - 1) * ticksPerBar(ts) + (bbt.beat - 1) * ticksPerBeatUnit(ts) + bbt.tick;
}

export function formatBBT(ticks: number, ts: TimeSignature): string {
  const { bar, beat, tick } = ticksToBBT(ticks, ts);
  return `${bar}.${beat}.${String(tick).padStart(3, '0')}`;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Snap grid choices, expressed as ticks (0 = off). */
export type SnapValue = 'off' | 'bar' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | '1/4T' | '1/8T' | '1/16T';

export const SNAP_VALUES: SnapValue[] = ['off', 'bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T'];

export function snapToTicks(snap: SnapValue, ts: TimeSignature): number {
  switch (snap) {
    case 'off':
      return 0;
    case 'bar':
      return ticksPerBar(ts);
    case '1/2':
      return PPQ * 2;
    case '1/4':
      return PPQ;
    case '1/8':
      return PPQ / 2;
    case '1/16':
      return PPQ / 4;
    case '1/32':
      return PPQ / 8;
    case '1/4T':
      return (PPQ * 2) / 3;
    case '1/8T':
      return PPQ / 3;
    case '1/16T':
      return PPQ / 6;
  }
}

/** Round to the nearest grid line. A grid of 0 means "no snapping" (integer ticks). */
export function quantize(ticks: number, grid: number): number {
  if (grid <= 0) return Math.round(ticks);
  return Math.round(Math.round(ticks / grid) * grid);
}

/** Floor to the grid line at or before `ticks`. */
export function quantizeFloor(ticks: number, grid: number): number {
  if (grid <= 0) return Math.floor(ticks);
  return Math.round(Math.floor(ticks / grid + 1e-9) * grid);
}

/**
 * Partial quantization: move `ticks` toward the nearest grid line by `strength` (0..1).
 * Used by the piano roll quantize command.
 */
export function quantizeStrength(ticks: number, grid: number, strength: number): number {
  const target = quantize(ticks, grid);
  return Math.round(ticks + (target - ticks) * Math.min(1, Math.max(0, strength)));
}

export function midiNoteToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** Apply coarse (semitones) and fine (cents) offsets to a MIDI note frequency. */
export function noteFrequencyWithOffsets(note: number, coarseSemitones: number, fineCents: number): number {
  return midiNoteToFrequency(note + coarseSemitones + fineCents / 100);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(note: number): string {
  const name = NOTE_NAMES[((note % 12) + 12) % 12] ?? '?';
  const octave = Math.floor(note / 12) - 1;
  return `${name}${octave}`;
}

export function isBlackKey(note: number): boolean {
  const n = ((note % 12) + 12) % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}
