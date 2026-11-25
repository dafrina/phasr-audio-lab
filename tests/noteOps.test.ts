import { describe, expect, it } from 'vitest';
import {
  copyNotes,
  createNote,
  deleteNotes,
  fitClipToNotes,
  moveNotes,
  notesInRect,
  pasteNotes,
  quantizeNotes,
  resizeNotesTo,
  scaleVelocity,
  setVelocity,
} from '../src/project/noteOps';
import { createMidiClip } from '../src/project/defaults';
import type { MidiNote } from '../src/project/types';

const n = (id: string, pitch: number, start: number, length = 240, velocity = 100): MidiNote => ({ id, pitch, start, length, velocity });

describe('note operations', () => {
  it('creates notes with clamped values', () => {
    const x = createNote(200, -5, 1, 300);
    expect(x.pitch).toBe(127);
    expect(x.start).toBe(0);
    expect(x.length).toBeGreaterThanOrEqual(10);
    expect(x.velocity).toBe(127);
  });

  it('moves a selection as a group and clamps at edges', () => {
    const notes = [n('a', 60, 100), n('b', 64, 500), n('c', 70, 0)];
    const moved = moveNotes(notes, new Set(['a', 'b']), -300, 2);
    expect(moved.find((x) => x.id === 'a')).toMatchObject({ start: 0, pitch: 62 });
    expect(moved.find((x) => x.id === 'b')).toMatchObject({ start: 400, pitch: 66 });
    expect(moved.find((x) => x.id === 'c')).toBe(notes[2]);
    const top = moveNotes([n('a', 120, 0), n('b', 125, 0)], new Set(['a', 'b']), 0, 10);
    expect(top.map((x) => x.pitch)).toEqual([122, 127]);
  });

  it('resizes relative to the anchor note', () => {
    const notes = [n('a', 60, 0, 240), n('b', 62, 0, 480)];
    const r = resizeNotesTo(notes, new Set(['a', 'b']), notes[0] as MidiNote, 480);
    expect(r.map((x) => x.length)).toEqual([480, 720]);
    const tiny = resizeNotesTo(notes, new Set(['a']), notes[0] as MidiNote, -100);
    expect(tiny[0]?.length).toBe(10);
  });

  it('deletes and edits velocity', () => {
    const notes = [n('a', 60, 0), n('b', 62, 0)];
    expect(deleteNotes(notes, new Set(['a'])).map((x) => x.id)).toEqual(['b']);
    expect(setVelocity(notes, new Set(['b']), 300)[1]?.velocity).toBe(127);
    expect(scaleVelocity(notes, new Set(['a']), -500)[0]?.velocity).toBe(1);
  });

  it('quantizes starts (with strength) and optionally ends', () => {
    const notes = [n('a', 60, 230, 200), n('b', 62, 500, 100)];
    expect(quantizeNotes(notes, null, { grid: 240 }).map((x) => x.start)).toEqual([240, 480]);
    expect(quantizeNotes(notes, new Set(['b']), { grid: 240, strength: 0.5 }).map((x) => x.start)).toEqual([230, 490]);
    const e = quantizeNotes(notes, null, { grid: 240, ends: true });
    expect(e.map((x) => x.length)).toEqual([240, 240]);
    expect(quantizeNotes(notes, null, { grid: 0 })).toBe(notes);
  });

  it('copies and pastes with fresh ids and relative positions', () => {
    const notes = [n('a', 60, 960), n('b', 64, 1200)];
    const clip = copyNotes(notes, new Set(['a', 'b']));
    expect(clip.span).toBe(480);
    const [all, ids] = pasteNotes(notes, clip, 3840);
    expect(all).toHaveLength(4);
    expect(ids).toHaveLength(2);
    expect(all.filter((x) => ids.includes(x.id)).map((x) => x.start)).toEqual([3840, 4080]);
    expect(ids).not.toContain('a');
  });

  it('grows a non-looping clip to fit its notes in whole bars', () => {
    const c = { ...createMidiClip('t', 0, 3840), notes: [n('a', 60, 3800, 200)] };
    expect(fitClipToNotes(c, 3840).length).toBe(7680);
    const looped = { ...c, loop: true };
    expect(fitClipToNotes(looped, 3840)).toBe(looped);
  });

  it('finds notes in a marquee rectangle', () => {
    const notes = [n('a', 60, 0, 240), n('b', 72, 480, 240), n('c', 65, 1000, 100)];
    expect(notesInRect(notes, 100, 600, 59, 73)).toEqual(['a', 'b']);
    expect(notesInRect(notes, 600, 100, 73, 59)).toEqual(['a', 'b']);
  });
});
