import { describe, expect, it } from 'vitest';
import { MidiFileError, isMidiFileName, midiToClipNotes, parseMidiFile, writeMidiFile } from '../src/midi/smf';

const PPQ = 960;
let n = 0;
const makeId = () => `n${++n}`;

describe('MIDI file reader', () => {
  it('reads what the writer wrote: notes, names, tempo, time signature', () => {
    const bytes = writeMidiFile({
      ppq: 480,
      bpm: 124,
      timeSignature: { numerator: 3, denominator: 4 },
      tracks: [
        { name: 'Lead', notes: [{ pitch: 60, start: 0, length: 240, velocity: 100 }, { pitch: 64, start: 480, length: 480, velocity: 80 }] },
        { name: 'Drums', channel: 9, notes: [{ pitch: 36, start: 0, length: 60, velocity: 127 }] },
      ],
    });
    const m = parseMidiFile(bytes);
    expect(m.format).toBe(1);
    expect(m.ppq).toBe(480);
    expect(m.bpm).toBeCloseTo(124, 1);
    expect(m.timeSignature).toEqual({ numerator: 3, denominator: 4 });
    expect(m.tracks.map((t) => t.name)).toEqual(['Lead', 'Drums']);
    expect(m.tracks[0]?.notes.map((x) => [x.pitch, x.start, x.length, x.velocity])).toEqual([
      [60, 0, 240, 100],
      [64, 480, 480, 80],
    ]);
    expect(m.tracks[1]?.channels).toEqual([9]);
  });

  it('handles running status, note-on velocity 0 as note-off, and overlapping same-pitch notes', () => {
    // format 0, ppq 96: C4 on, (running) E4 on, C4 "on vel 0", E4 off via 0x80, then two overlapping D4s
    const track = [
      0x00, 0x90, 60, 100,
      0x00, 64, 90, // running status
      0x60, 60, 0, // C4 off after 96 ticks (vel 0)
      0x30, 0x80, 64, 0,
      0x00, 0x90, 62, 70,
      0x10, 62, 71, // second D4 while the first still sounds
      0x10, 62, 0, // closes the first
      0x10, 62, 0, // closes the second
      0x00, 0xff, 0x2f, 0x00,
    ];
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
    const m = parseMidiFile(bytes);
    const notes = m.tracks[0]!.notes.map((x) => [x.pitch, x.start, x.length, x.velocity]);
    expect(notes).toEqual([
      [60, 0, 96, 100],
      [64, 0, 144, 90],
      [62, 144, 32, 70],
      [62, 160, 32, 71],
    ]);
    expect(m.bpm).toBeNull();
  });

  it('converts to project ticks and trims empty bars before the first note', () => {
    // a phrase starting in bar 3 (4/4, file ppq 96)
    const notes = [{ pitch: 60, start: 96 * 8 + 48, length: 96, velocity: 90, channel: 0 }];
    const kept = midiToClipNotes(notes, 96, PPQ, { barTicks: PPQ * 4, makeId });
    expect(kept[0]?.start).toBe(PPQ * 8 + PPQ / 2);
    expect(kept[0]?.length).toBe(PPQ);
    const trimmed = midiToClipNotes(notes, 96, PPQ, { barTicks: PPQ * 4, trimLeadIn: true, makeId });
    // whole bars removed, the offset inside the bar stays
    expect(trimmed[0]?.start).toBe(PPQ / 2);
  });

  it('rejects files that are not MIDI, with a readable message', () => {
    expect(() => parseMidiFile(new TextEncoder().encode('RIFF....WAVEfmt '))).toThrow(MidiFileError);
    const empty = writeMidiFile({ ppq: 480, bpm: 120, tracks: [{ name: 'x', notes: [] }] });
    expect(() => parseMidiFile(empty)).toThrow(/no notes/);
  });

  it('keeps the notes of a truncated file', () => {
    const bytes = writeMidiFile({ ppq: 480, bpm: 120, tracks: [{ name: 'Piano', notes: [{ pitch: 60, start: 0, length: 480, velocity: 100 }, { pitch: 62, start: 480, length: 480, velocity: 100 }] }] });
    const cut = bytes.slice(0, bytes.length - 6);
    const m = parseMidiFile(cut);
    expect(m.tracks[0]?.notes.length).toBeGreaterThanOrEqual(1);
  });

  it('recognises MIDI file names', () => {
    for (const f of ['song.mid', 'Song.MIDI', 'x.kar']) expect(isMidiFileName(f)).toBe(true);
    for (const f of ['song.wav', 'mid.mp3', 'midi']) expect(isMidiFileName(f)).toBe(false);
  });
});
