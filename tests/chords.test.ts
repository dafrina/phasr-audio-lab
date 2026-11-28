import { describe, expect, it } from 'vitest';
import {
  QUALITIES,
  VIBES,
  chordAtSlot,
  chordForKey,
  defaultChordTool,
  expandNote,
  keyName,
  keyToSlot,
  sanitizeChordTool,
  voiceChord,
  type ChordToolConfig,
} from '../src/chords/theory';

const BAR = 3840;
const cfg = (o: Partial<ChordToolConfig> = {}): ChordToolConfig => ({ ...defaultChordTool('deephouse'), ...o });
const pcs = (notes: number[]) => [...new Set(notes.map((n) => n % 12))].sort((a, b) => a - b);

describe('Slipper-izer key mapping', () => {
  it('white keys pick chords 1–7, black keys spice the chord to their left, octaves shift', () => {
    expect(keyToSlot(60)).toEqual({ slot: 0, spice: false, octave: 0 });
    expect(keyToSlot(65)).toEqual({ slot: 3, spice: false, octave: 0 });
    expect(keyToSlot(71)).toEqual({ slot: 6, spice: false, octave: 0 });
    expect(keyToSlot(61)).toEqual({ slot: 0, spice: true, octave: 0 });
    expect(keyToSlot(70)).toEqual({ slot: 5, spice: true, octave: 0 });
    expect(keyToSlot(48)).toEqual({ slot: 0, spice: false, octave: -1 });
  });

  it('names chords in the chosen key', () => {
    const c = cfg({ key: 9 }); // A minor, "Late Night Organ"
    expect(keyName(c)).toBe('A minor');
    expect([60, 62, 64, 65].map((p) => chordForKey(c, p).name)).toEqual(['Am9', 'Fmaj9', 'Dm9', 'Em7']);
    // transposing the key transposes every chord
    expect(chordForKey(cfg({ key: 5 }), 60).name).toBe('Fm9');
    // flat keys are spelled with flats
    expect(chordForKey(cfg({ key: 0 }), 62).name).toBe('A♭maj9');
  });

  it('every palette chord uses a known quality and every vibe has 7 chords per progression', () => {
    for (const v of VIBES) {
      expect(v.progressions.length).toBeGreaterThanOrEqual(2);
      for (const p of v.progressions) {
        expect(p.chords).toHaveLength(7);
        for (const [deg, q] of p.chords) {
          expect(deg).toBeGreaterThanOrEqual(0);
          expect(deg).toBeLessThan(12);
          expect(QUALITIES[q]).toBeDefined();
        }
      }
    }
  });
});

describe('Slipper-izer voicing', () => {
  it('a chord contains exactly its chord tones (root in the bass)', () => {
    const c = cfg({ key: 9 });
    const ch = chordAtSlot(c, 0); // Am9 = A C E G B
    const { bass, upper } = voiceChord(ch, c);
    expect(bass !== null && bass % 12).toBe(9);
    expect(pcs([bass as number, ...upper])).toEqual([0, 4, 7, 9, 11]);
    expect(bass as number).toBeLessThan(upper[0] as number);
  });

  it('keeps consecutive chords close together (smooth voice leading)', () => {
    for (const v of VIBES) {
      const c = cfg({ vibe: v.id, key: v.defaultKey });
      const voicings = [60, 62, 64, 65].map((p) => voiceChord(chordForKey(c, p), c).upper);
      for (let i = 1; i < voicings.length; i++) {
        const a = voicings[i - 1] as number[];
        const b = voicings[i] as number[];
        const mean = (x: number[]) => x.reduce((s, n) => s + n, 0) / x.length;
        expect(Math.abs(mean(a) - mean(b)), `${v.id} chord ${i}`).toBeLessThan(6);
        expect((b[b.length - 1] as number) - (b[0] as number)).toBeLessThanOrEqual(24);
      }
    }
  });

  it('wide voicing spreads the chord; octave shifts move it', () => {
    const c = cfg({ key: 9 });
    const ch = chordAtSlot(c, 0);
    const close = voiceChord(ch, c).upper;
    const wide = voiceChord(ch, { ...c, voicing: 'wide' }).upper;
    expect((wide.at(-1) as number) - (wide[0] as number)).toBeGreaterThan((close.at(-1) as number) - (close[0] as number));
    expect(pcs(wide)).toEqual(pcs(close));
    const up = voiceChord(ch, c, 1).upper;
    expect(up.map((n, i) => n - (close[i] as number))).toEqual(close.map(() => 12));
  });

  it('black keys add colour notes', () => {
    const c = cfg({ key: 9 });
    const plain = chordAtSlot(c, 0).intervals;
    const spicy = chordAtSlot(c, 0, true).intervals;
    expect(spicy.length).toBeGreaterThan(plain.length);
    expect(spicy).toContain(17); // m9 → m11
  });
});

describe('Slipper-izer note expansion', () => {
  it('chord mode: one note becomes the whole chord with the same timing', () => {
    const c = cfg({ key: 9 });
    const out = expandNote(c, { pitch: 60, start: 480, length: 960, velocity: 100 }, BAR);
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const n of out) {
      expect(n.start).toBe(480);
      expect(n.length).toBe(960);
    }
    expect(pcs(out.map((n) => n.pitch))).toEqual([0, 4, 7, 9, 11]);
  });

  it('strum rolls the chord from low to high', () => {
    const out = expandNote(cfg({ strum: 1 }), { pitch: 60, start: 0, length: 960, velocity: 100 }, BAR);
    const starts = out.map((n) => n.start);
    expect(starts[0]).toBe(0);
    expect(Math.max(...starts)).toBeGreaterThan(60);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('auto-play: one held key plays the 4-chord progression, one chord per bar', () => {
    const c = cfg({ key: 9, play: 'auto', pattern: 'hold', chordBars: 1 });
    const out = expandNote(c, { pitch: 60, start: 0, length: 4 * BAR, velocity: 100 }, BAR);
    const chordAtBar = (b: number) => pcs(out.filter((n) => n.start === b * BAR).map((n) => n.pitch));
    expect(chordAtBar(0)).toEqual(pcs([9, 0, 4, 7, 11])); // Am9
    expect(chordAtBar(1)).toEqual(pcs([5, 9, 0, 4, 7])); // Fmaj9
    expect(chordAtBar(2)).toEqual(pcs([2, 5, 9, 0, 4])); // Dm9
    expect(chordAtBar(3)).toEqual(pcs([4, 7, 11, 2])); // Em7
    // pressing D starts the loop on chord 2
    const fromD = expandNote(c, { pitch: 62, start: 0, length: BAR, velocity: 100 }, BAR);
    expect(pcs(fromD.map((n) => n.pitch))).toEqual(pcs([5, 9, 0, 4, 7]));
  });

  it('auto-play patterns lock to the bar grid and stay inside the held note', () => {
    const c = cfg({ key: 9, play: 'auto', pattern: 'offbeat', chordBars: 1, bass: false });
    const out = expandNote(c, { pitch: 60, start: 0, length: BAR, velocity: 90 }, BAR);
    const starts = [...new Set(out.map((n) => n.start))];
    expect(starts).toEqual([480, 1440, 2400, 3360]);
    for (const n of out) expect(n.start + n.length).toBeLessThanOrEqual(BAR);
    const arp = expandNote({ ...c, pattern: 'arp', rate: 16 }, { pitch: 60, start: 0, length: BAR, velocity: 90 }, BAR);
    expect(arp).toHaveLength(16);
    expect(new Set(arp.map((n) => n.pitch)).size).toBeGreaterThan(2);
  });

  it('a note starting mid-bar changes chord on the next bar line', () => {
    const c = cfg({ key: 9, play: 'auto', pattern: 'hold', chordBars: 1, bass: false });
    const out = expandNote(c, { pitch: 60, start: 1920, length: BAR, velocity: 90 }, BAR);
    expect([...new Set(out.map((n) => n.start))]).toEqual([1920, 3840]);
  });

  it('sanitize repairs bad data', () => {
    expect(sanitizeChordTool(null)).toBeNull();
    const s = sanitizeChordTool({ vibe: 'nope', key: 40, progression: 99, rate: 3, octave: 9 });
    expect(s?.vibe).toBe('deephouse');
    expect(s?.key).toBe(11);
    expect(s?.progression).toBe(2);
    expect(s?.rate).toBe(8);
    // (no octave setting of its own any more: the played key's octave moves the chords)
    expect(s && 'octave' in s).toBe(false);
  });
});

import { bakeChords, chordToolActive, withChordsExpanded } from '../src/chords/expand';
import { createMidiClip, createProject } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import { planWindow } from '../src/audio/scheduling';
import type { Project } from '../src/project/types';

function chordProject(): { p: Project; trackId: string; clipId: string } {
  const p = createProject();
  const track = p.tracks.find((t) => t.kind === 'instrument');
  if (!track) throw new Error('no instrument track');
  const clip = { ...createMidiClip(track.id, BAR, BAR), notes: [{ id: 'n1', pitch: 60, start: 0, length: 960, velocity: 100 }, { id: 'n2', pitch: 62, start: 1920, length: 960, velocity: 100 }] };
  return {
    p: { ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, chords: { ...defaultChordTool('deephouse') } } : t)), clips: { [clip.id]: clip } },
    trackId: track.id,
    clipId: clip.id,
  };
}

describe('Slipper-izer in the project', () => {
  it('clips keep the single notes; the scheduler hears the chords', () => {
    const { p, clipId } = chordProject();
    const heard = withChordsExpanded(p);
    expect(p.clips[clipId]?.kind === 'midi' && p.clips[clipId].notes).toHaveLength(2);
    const notes = heard.clips[clipId]?.kind === 'midi' ? heard.clips[clipId].notes : [];
    expect(notes.length).toBeGreaterThanOrEqual(8);
    // memoised: same input, same object (cheap per scheduler pass)
    expect(withChordsExpanded(p)).toBe(heard);
    // switched off → untouched
    const off = { ...p, tracks: p.tracks.map((t) => (t.chords ? { ...t, chords: { ...t.chords, enabled: false } } : t)) };
    expect(withChordsExpanded(off)).toBe(off);
    // the planner schedules every chord tone (bar 2 at 120 BPM = 2 s)
    const plan = planWindow(
      { bpm: 120, loop: { ...heard.loop, enabled: false }, beatTicks: 960, barTicks: BAR, metronome: false, tracks: heard.tracks, clips: Object.values(heard.clips) },
      { tick: BAR, time: 0, fresh: true },
      2.1,
    );
    expect(plan.notes.length).toBe(notes.length);
    expect(Math.min(...plan.notes.map((n) => n.onTime))).toBeCloseTo(0, 6);
  });

  it('bake writes the chords into the clip and switches the tool off', () => {
    const { p, trackId, clipId } = chordProject();
    const heard = withChordsExpanded(p).clips[clipId];
    const baked = bakeChords(p, trackId);
    const c = baked.clips[clipId];
    expect(c?.kind === 'midi' && c.notes.map((n) => [n.pitch, n.start, n.length])).toEqual(heard?.kind === 'midi' && heard.notes.map((n) => [n.pitch, n.start, n.length]));
    expect(chordToolActive(baked.tracks.find((t) => t.id === trackId))).toBe(false);
    expect(new Set(c?.kind === 'midi' ? c.notes.map((n) => n.id) : []).size).toBe(c?.kind === 'midi' ? c.notes.length : -1);
    // baking twice is a no-op (tool already off)
    expect(bakeChords(baked, trackId)).toBe(baked);
  });

  it('survives save/load and old projects get no chord tool', () => {
    const { p, trackId } = chordProject();
    const loaded = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(loaded.tracks.find((t) => t.id === trackId)?.chords).toEqual(p.tracks.find((t) => t.id === trackId)?.chords);
    const old = JSON.parse(JSON.stringify(createProject()));
    for (const t of old.tracks) delete t.chords;
    expect(migrateProject(old).tracks.every((t) => t.chords === null)).toBe(true);
  });
});

import { createTrack } from '../src/project/defaults';

describe('the Slipper-izer octave setting moved to the keyboard (schema 5)', () => {
  /** a v4 file: the chord tool with its own octave, on two tracks — one on, one switched off */
  function v4(octOn: number, octOff: number): unknown {
    const p = createProject();
    const a = createTrack('instrument', 0);
    const b = createTrack('instrument', 1);
    p.tracks = [a, b];
    const ca = { ...createMidiClip(a.id, 0, BAR), notes: [{ id: 'a1', pitch: 60, start: 0, length: 960, velocity: 100 }] };
    const cb = { ...createMidiClip(b.id, 0, BAR), notes: [{ id: 'b1', pitch: 62, start: 0, length: 960, velocity: 100 }] };
    const tracks = p.tracks.map((t) =>
      t.id === a.id ? { ...t, chords: { ...defaultChordTool('deephouse'), octave: octOn } } : t.id === b.id ? { ...t, chords: { ...defaultChordTool('deephouse'), enabled: false, octave: octOff } } : t,
    );
    return JSON.parse(JSON.stringify({ ...p, schemaVersion: 4, tracks, clips: { [ca.id]: ca, [cb.id]: cb } }));
  }
  const pitchesOn = (p: Project) => {
    const heard = withChordsExpanded(p);
    const c = Object.values(heard.clips).find((x) => x.kind === 'midi' && x.trackId === p.tracks.filter((t) => t.kind === 'instrument')[0]!.id);
    return c?.kind === 'midi' ? c.notes.map((n) => n.pitch).sort((x, y) => x - y) : [];
  };

  it('a track that had it at +1 plays the very same chords: its keys move up an octave instead', () => {
    const p = migrateProject(v4(1, -1));
    const [a, b] = p.tracks.filter((t) => t.kind === 'instrument');
    expect(a!.chords && 'octave' in a!.chords).toBe(false);
    const keys = (id: string) => Object.values(p.clips).flatMap((c) => (c.kind === 'midi' && c.trackId === id ? c.notes.map((n) => n.pitch) : []));
    expect(keys(a!.id)).toEqual([72]);
    // C4 with the old octave +1 played this chord (the same as C5 now)
    expect(pitchesOn(p)).toEqual([57, 71, 72, 76, 79]);
    // the Slipper-izer was off on the other track: its notes play themselves, so they stay
    expect(keys(b!.id)).toEqual([62]);
    expect(b!.chords && 'octave' in b!.chords).toBe(false);
  });

  it('at octave 0 (the default, and every project made with it) nothing moves', () => {
    const p = migrateProject(v4(0, 0));
    expect(pitchesOn(p)).toEqual([45, 59, 60, 64, 67]);
    expect(Object.values(p.clips).flatMap((c) => (c.kind === 'midi' ? c.notes.map((n) => n.pitch) : [])).sort()).toEqual([60, 62]);
  });
});
