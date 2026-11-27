/**
 * Pure clip editing operations. They return new clip objects and never touch
 * source audio; trimming an audio clip only changes which region of its asset
 * is played. (MIDI notes a trim or split cuts off a non-looped clip are
 * removed from it — they don't come back when the edge is dragged out again.)
 */
import { createId } from '../core/ids';
import { secondsToTicks, ticksToSeconds } from '../core/time';
import type { AudioClip, Clip, MidiClip, MidiNote } from './types';

export const MIN_CLIP_TICKS = 60;

export function clipEnd(clip: Clip): number {
  return clip.start + clip.length;
}

export function moveClip<C extends Clip>(clip: C, newStart: number, trackId?: string): C {
  return { ...clip, start: Math.max(0, Math.round(newStart)), trackId: trackId ?? clip.trackId };
}

/** Length in ticks of the source material available after `sourceOffset`. */
export function audioAvailableTicks(clip: AudioClip, assetDurationSec: number, bpm: number): number {
  if (clip.loop) return Number.POSITIVE_INFINITY;
  return secondsToTicks(Math.max(0, assetDurationSec - clip.sourceOffset), bpm);
}

/**
 * Move the left edge of a clip to `newStart` (ticks), keeping the right edge
 * fixed and everything that plays where it was on the timeline. For audio
 * clips the source offset shifts with it (clamped at the start of the asset).
 * A looping clip's content repeats, so its loop is rotated instead: the
 * repeats stay put, and the edge can also move left past the first repeat.
 */
export function trimClipStart(clip: Clip, newStart: number, bpm: number): Clip {
  const end = clipEnd(clip);
  let start = Math.min(Math.round(newStart), end - MIN_CLIP_TICKS);
  start = Math.max(0, start);
  if (clip.kind === 'audio' && clip.loop && clip.loopSeconds > 0) {
    // the loop region in the source stays; only the phase within it moves (as in splitClip)
    const L = clip.loopSeconds;
    const phase = (((clip.loopStartPhase + ticksToSeconds(start - clip.start, bpm)) % L) + L) % L;
    return { ...clip, start, length: end - start, loopStartPhase: phase };
  }
  if (clip.kind === 'midi' && clip.loop && clip.loopLength > 0) {
    const L = clip.loopLength;
    const rot = ((((start - clip.start) % L) + L) % L) | 0;
    const notes = clip.notes.map((n) => {
      if (n.start >= L) return n; // past the loop: never plays, keep it as it is
      const s = (n.start - rot + L) % L;
      // it played up to the old loop seam; a note now crossing the new seam is cut there
      // (splitting it would add a hit at every repeat)
      return { ...n, start: s, length: Math.max(1, Math.min(n.length, L - n.start, L - s)) };
    });
    return { ...clip, start, length: end - start, notes };
  }
  if (clip.kind === 'audio') {
    let delta = start - clip.start;
    let offset = clip.sourceOffset + ticksToSeconds(delta, bpm);
    if (offset < 0) {
      // can't extend before the beginning of the source audio
      delta -= secondsToTicks(offset, bpm);
      offset = 0;
      start = Math.round(clip.start + delta);
    }
    return { ...clip, start, length: end - start, sourceOffset: offset };
  }
  // MIDI: shift notes so they stay put on the timeline, drop ones that fall outside.
  const delta = start - clip.start;
  const notes = shiftNotes(clip.notes, -delta).filter((n) => n.start + n.length > 0 && n.start < end - start);
  const clipped = notes.map((n) => (n.start < 0 ? { ...n, length: n.length + n.start, start: 0 } : n));
  return { ...clip, start, length: end - start, notes: clipped, loopLength: clip.loop ? clip.loopLength : end - start };
}

/** Move the right edge of a clip. Audio clips are limited by available source audio. */
export function trimClipEnd(clip: Clip, newEnd: number, bpm: number, assetDurationSec?: number): Clip {
  let length = Math.max(MIN_CLIP_TICKS, Math.round(newEnd) - clip.start);
  if (clip.kind === 'audio' && assetDurationSec !== undefined) {
    length = Math.min(length, Math.floor(audioAvailableTicks(clip, assetDurationSec, bpm)));
    length = Math.max(MIN_CLIP_TICKS, length);
  }
  if (clip.kind === 'midi' && !clip.loop) {
    return { ...clip, length, loopLength: length };
  }
  return { ...clip, length };
}

function shiftNotes(notes: MidiNote[], delta: number): MidiNote[] {
  return notes.map((n) => ({ ...n, start: n.start + delta }));
}

/**
 * Split a clip at an absolute tick position. Returns [left, right] or null if
 * the position isn't strictly inside the clip.
 */
export function splitClip(clip: Clip, at: number, bpm: number): [Clip, Clip] | null {
  const t = Math.round(at);
  if (t <= clip.start + MIN_CLIP_TICKS / 2 || t >= clipEnd(clip) - MIN_CLIP_TICKS / 2) return null;
  const leftLen = t - clip.start;
  const rightLen = clipEnd(clip) - t;
  if (clip.kind === 'audio') {
    const left: AudioClip = { ...clip, length: leftLen };
    const leftSec = ticksToSeconds(leftLen, bpm);
    const right: AudioClip =
      clip.loop && clip.loopSeconds > 0
        ? {
            ...clip,
            id: createId('clp'),
            start: t,
            length: rightLen,
            // the loop region stays the same; only the phase within it moves
            loopStartPhase: (clip.loopStartPhase + leftSec) % clip.loopSeconds,
          }
        : { ...clip, id: createId('clp'), start: t, length: rightLen, sourceOffset: clip.sourceOffset + leftSec };
    return [left, right];
  }
  const expanded = expandMidiClipNotes(clip);
  const leftNotes = expanded
    .filter((n) => n.start < leftLen)
    .map((n) => ({ ...n, length: Math.min(n.length, leftLen - n.start) }));
  const rightNotes = expanded
    .filter((n) => n.start >= leftLen)
    .map((n) => ({ ...n, id: createId('n'), start: n.start - leftLen }));
  const left: MidiClip = { ...clip, length: leftLen, loopLength: leftLen, loop: false, notes: leftNotes };
  const right: MidiClip = {
    ...clip,
    id: createId('clp'),
    start: t,
    length: rightLen,
    loopLength: rightLen,
    loop: false,
    notes: rightNotes,
  };
  return [left, right];
}

/** Flatten a (possibly looping) MIDI clip's notes into clip-relative positions. */
export function expandMidiClipNotes(clip: MidiClip): MidiNote[] {
  if (!clip.loop || clip.loopLength <= 0 || clip.loopLength >= clip.length) {
    return clip.notes.filter((n) => n.start < clip.length);
  }
  const out: MidiNote[] = [];
  for (let offset = 0; offset < clip.length; offset += clip.loopLength) {
    for (const n of clip.notes) {
      if (n.start >= clip.loopLength) continue;
      const s = offset + n.start;
      if (s >= clip.length) continue;
      out.push({ ...n, id: offset === 0 ? n.id : createId('n'), start: s, length: Math.min(n.length, clip.length - s) });
    }
  }
  return out;
}

export function duplicateClip<C extends Clip>(clip: C, newStart?: number): C {
  const copy = { ...clip, id: createId('clp'), start: newStart ?? clipEnd(clip) };
  if (copy.kind === 'midi') {
    return { ...copy, notes: copy.notes.map((n) => ({ ...n, id: createId('n') })) };
  }
  return copy;
}

/** Toggle content looping. Turning it on fixes the current length as the loop length. */
export function setClipLoop(clip: Clip, loop: boolean, bpm: number): Clip {
  if (clip.kind === 'midi') {
    return { ...clip, loop, loopLength: loop ? clip.loopLength || clip.length : clip.length };
  }
  return { ...clip, loop, loopSeconds: loop ? clip.loopSeconds || ticksToSeconds(clip.length, bpm) : 0, loopStartPhase: 0 };
}
