/**
 * Pure MIDI note editing operations. Note positions are clip-relative ticks.
 * All functions return new arrays/objects; inputs are never mutated.
 */
import { createId } from '../core/ids';
import { quantize, quantizeStrength } from '../core/time';
import type { MidiClip, MidiNote } from './types';

export const MIN_NOTE_TICKS = 10;

export function clampPitch(p: number): number {
  return Math.min(127, Math.max(0, Math.round(p)));
}

export function clampVelocity(v: number): number {
  return Math.min(127, Math.max(1, Math.round(v)));
}

export function createNote(pitch: number, start: number, length: number, velocity = 100): MidiNote {
  return {
    id: createId('n'),
    pitch: clampPitch(pitch),
    start: Math.max(0, Math.round(start)),
    length: Math.max(MIN_NOTE_TICKS, Math.round(length)),
    velocity: clampVelocity(velocity),
  };
}

export function sortNotes(notes: MidiNote[]): MidiNote[] {
  return [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * Move a set of notes by (dTicks, dPitch). The whole group is clamped so no
 * note goes before tick 0 or outside the MIDI range, keeping the group's shape.
 */
export function moveNotes(notes: MidiNote[], ids: ReadonlySet<string>, dTicks: number, dPitch: number): MidiNote[] {
  const sel = notes.filter((n) => ids.has(n.id));
  if (!sel.length) return notes;
  const minStart = Math.min(...sel.map((n) => n.start));
  const minPitch = Math.min(...sel.map((n) => n.pitch));
  const maxPitch = Math.max(...sel.map((n) => n.pitch));
  const dt = Math.max(Math.round(dTicks), -minStart);
  const dp = Math.min(Math.max(Math.round(dPitch), -minPitch), 127 - maxPitch);
  if (dt === 0 && dp === 0) return notes;
  return notes.map((n) => (ids.has(n.id) ? { ...n, start: n.start + dt, pitch: n.pitch + dp } : n));
}

/** Change the length of selected notes by dTicks (each relative to its original length). */
export function resizeNotes(notes: MidiNote[], ids: ReadonlySet<string>, dTicks: number, minLength = MIN_NOTE_TICKS): MidiNote[] {
  return notes.map((n) => (ids.has(n.id) ? { ...n, length: Math.max(minLength, Math.round(n.length + dTicks)) } : n));
}

/** Set the end of selected notes so the anchor note ends at `end` (others keep relative change). */
export function resizeNotesTo(notes: MidiNote[], ids: ReadonlySet<string>, anchor: MidiNote, end: number, minLength = MIN_NOTE_TICKS): MidiNote[] {
  const newLen = Math.max(minLength, Math.round(end - anchor.start));
  return resizeNotes(notes, ids, newLen - anchor.length, minLength);
}

export function deleteNotes(notes: MidiNote[], ids: ReadonlySet<string>): MidiNote[] {
  return notes.filter((n) => !ids.has(n.id));
}

export function setVelocity(notes: MidiNote[], ids: ReadonlySet<string>, velocity: number): MidiNote[] {
  const v = clampVelocity(velocity);
  return notes.map((n) => (ids.has(n.id) ? { ...n, velocity: v } : n));
}

export function scaleVelocity(notes: MidiNote[], ids: ReadonlySet<string>, delta: number): MidiNote[] {
  return notes.map((n) => (ids.has(n.id) ? { ...n, velocity: clampVelocity(n.velocity + delta) } : n));
}

/**
 * Velocity drag on one note of a selection: the anchor goes to `velocity` and the
 * other selected notes move by the same amount (accents are kept), or with `same`
 * all take that value. Pass the notes as they were when the drag began, so values
 * clamped at 1 or 127 come back when the drag returns.
 */
export function setVelocityFrom(notes: MidiNote[], ids: ReadonlySet<string>, anchor: MidiNote, velocity: number, same = false): MidiNote[] {
  if (same) return setVelocity(notes, ids, velocity);
  return scaleVelocity(notes, ids, clampVelocity(velocity) - anchor.velocity);
}

export interface QuantizeOptions {
  grid: number;
  /** 0..1, how far starts move toward the grid */
  strength?: number;
  /** also snap note ends (lengths) to the grid */
  ends?: boolean;
}

/** Quantize the selected notes (or all notes when `ids` is null). */
export function quantizeNotes(notes: MidiNote[], ids: ReadonlySet<string> | null, opts: QuantizeOptions): MidiNote[] {
  const { grid, strength = 1, ends = false } = opts;
  if (grid <= 0) return notes;
  return notes.map((n) => {
    if (ids && !ids.has(n.id)) return n;
    const start = Math.max(0, quantizeStrength(n.start, grid, strength));
    let length = n.length;
    if (ends) {
      const end = quantize(n.start + n.length, grid);
      length = Math.max(grid, end - start);
    }
    return { ...n, start, length };
  });
}

/** Copy notes into a clipboard representation, relative to the earliest start. */
export function copyNotes(notes: MidiNote[], ids: ReadonlySet<string>): { notes: MidiNote[]; span: number } {
  const sel = notes.filter((n) => ids.has(n.id));
  if (!sel.length) return { notes: [], span: 0 };
  const origin = Math.min(...sel.map((n) => n.start));
  const end = Math.max(...sel.map((n) => n.start + n.length));
  return { notes: sel.map((n) => ({ ...n, start: n.start - origin })), span: end - origin };
}

/** Paste clipboard notes at `at`, giving them fresh ids. Returns [allNotes, pastedIds]. */
export function pasteNotes(notes: MidiNote[], clip: { notes: MidiNote[] }, at: number): [MidiNote[], string[]] {
  const pasted = clip.notes.map((n) => ({ ...n, id: createId('n'), start: Math.max(0, Math.round(at + n.start)) }));
  return [[...notes, ...pasted], pasted.map((n) => n.id)];
}

/** Ensure a non-looping clip is long enough to contain all its notes (grows to whole bars). */
export function fitClipToNotes(clip: MidiClip, barTicks: number): MidiClip {
  if (clip.loop) return clip;
  const end = Math.max(0, ...clip.notes.map((n) => n.start + n.length));
  if (end <= clip.length) return clip;
  const length = Math.ceil(end / barTicks) * barTicks;
  return { ...clip, length, loopLength: length };
}

/** Notes overlapping a rectangle in (tick, pitch) space, used for marquee selection. */
export function notesInRect(notes: MidiNote[], t0: number, t1: number, p0: number, p1: number): string[] {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const plo = Math.min(p0, p1);
  const phi = Math.max(p0, p1);
  return notes.filter((n) => n.start < hi && n.start + n.length > lo && n.pitch >= plo && n.pitch <= phi).map((n) => n.id);
}
