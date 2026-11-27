import { describe, expect, it } from 'vitest';
import v1Kit from './fixtures/drumKitV1.json';
import { DRUM_BASE_NOTE, DRUM_MODELS, FACTORY_KITS, defaultKit } from '../src/drums/kit';
import { GM_DRUM_NAMES, kitGmNotes, padNoteForGm } from '../src/drums/gm';
import { INSTRUMENTS } from '../src/instruments/definitions';
import { createMidiClip, createProject, createTrack } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import { clipToMidi, projectToMidi } from '../src/midi/export';
import { parseMidiFile, writeMidiFile } from '../src/midi/smf';
import { PROJECT_SCHEMA_VERSION, type DrumKit, type DrumPad, type MidiClip, type Project } from '../src/project/types';
import { useProjectStore } from '../src/state/projectStore';

const PPQ = 960;
const padOn = (kit: DrumKit, note: number) => kit.pads[note - DRUM_BASE_NOTE];
const voice = (p: DrumPad | undefined) => (p?.source.kind === 'synth' ? p.source.voice : null);
const notesOf = (kit: DrumKit, v: string) => kit.pads.flatMap((p, i) => (voice(p) === v ? [DRUM_BASE_NOTE + i] : []));
const TOMS = [41, 43, 45, 47, 48, 50];

describe('Drum Rack kits follow the General MIDI drum map', () => {
  it('every factory kit: kick 36, side stick 37, snare 38, clap 39, closed hat 42, open hat 46', () => {
    for (const { name, kit } of FACTORY_KITS) {
      expect([36, 37, 38, 39, 42, 46].map((n) => voice(padOn(kit, n))), name).toEqual(['kick', 'rim', 'snare', 'clap', 'hatClosed', 'hatOpen']);
      // the hats choke each other
      expect(padOn(kit, 42)!.choke, name).toBeGreaterThan(0);
      expect(padOn(kit, 46)!.choke, name).toBe(padOn(kit, 42)!.choke);
    }
  });

  it('every factory kit: toms only on GM tom keys, cymbals on crash 49 / ride 51, a second snare on 40', () => {
    for (const { name, kit } of FACTORY_KITS) {
      for (const n of notesOf(kit, 'tom')) expect(TOMS, `${name} tom on ${n}`).toContain(n);
      for (const n of notesOf(kit, 'crash')) expect([49, 51], `${name} cymbal on ${n}`).toContain(n);
      const second = voice(padOn(kit, 40));
      expect(['snare', 'clap'], name).toContain(second);
    }
    // the toms of the default kit go up in pitch with the key, like GM
    const k = defaultKit();
    const tones = notesOf(k, 'tom').map((n) => (padOn(k, n)!.source as { tone: number }).tone);
    expect(tones).toEqual([...tones].sort((a, b) => a - b));
  });

  it('the default kit is the old one, rearranged: the same 16 pads, nothing re-voiced', () => {
    const key = (p: DrumPad) => JSON.stringify(p);
    expect(defaultKit().pads.map(key).sort()).toEqual((v1Kit.pads as DrumPad[]).map(key).sort());
  });

  it('knows the GM key names (Level 1, plus the Level 2 extras the kit writes)', () => {
    expect(GM_DRUM_NAMES[42]).toBe('Closed Hi-Hat');
    expect(GM_DRUM_NAMES[56]).toBe('Cowbell');
    expect(GM_DRUM_NAMES[27]).toBe('High Q');
    for (let n = 35; n <= 81; n++) expect(GM_DRUM_NAMES[n], `GM key ${n}`).toBeTruthy();
    // the style-specific GM sounds rely on these model slots
    expect(DRUM_MODELS.crash[1]).toMatch(/ride/i);
    expect(DRUM_MODELS.zap[3]).toMatch(/scratch/i);
  });
});

/** a schema-1 project: one drum track with the old default kit, a beat on every pad, a pad lane and a sidechain on one pad */
function v1Project(kit: unknown = v1Kit): Record<string, unknown> {
  const p = createProject('Old beat');
  const drums = createTrack('instrument', 0, INSTRUMENTS.drumrack.createConfig());
  drums.id = 'drums';
  (drums.instrument as { kit: unknown }).kit = structuredClone(kit);
  drums.automation = [
    { id: 'l1', target: { kind: 'inst', param: 'p5.gain' }, enabled: true, points: [{ id: 'a', tick: 0, value: -6 }] },
    { id: 'l2', target: { kind: 'track', param: 'pan' }, enabled: true, points: [{ id: 'b', tick: 0, value: 0.5 }] },
  ];
  const bass = createTrack('instrument', 1, INSTRUMENTS.triosc.createConfig());
  bass.id = 'bass';
  const base = { sourceTrackId: 'drums', source: 'midi', depth: -12, attack: 0.001, release: 0.2, threshold: -30, hold: 0, invert: false, enabled: true };
  bass.modulations = [
    { ...base, id: 'm1', note: 41, target: { kind: 'track', param: 'volumeDb' } }, // ducked by the old closed hat
    { ...base, id: 'm2', note: null, target: { kind: 'track', param: 'pan' } }, // any hit
  ] as never;
  const notes = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, pitch: 36 + i, start: i * 240, length: 60, velocity: 100 }));
  const beat = { ...createMidiClip('drums', 0, PPQ * 4), id: 'beat', notes: [...notes, { id: 'low', pitch: 30, start: 0, length: 60, velocity: 90 }] };
  const lead = { ...createMidiClip('bass', 0, PPQ * 4), id: 'lead', notes: [{ id: 'x', pitch: 41, start: 0, length: 60, velocity: 90 }] };
  return JSON.parse(JSON.stringify({ ...p, schemaVersion: 1, tracks: [drums, bass], clips: { beat, lead } }));
}

describe('opening a schema-1 project (pads on the old layout)', () => {
  it('moves the pads and their notes together: every note plays the same pad as before', () => {
    const raw = v1Project();
    const p = migrateProject(raw);
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    const kit = (p.tracks[0]!.instrument as { kit: DrumKit }).kit;
    const before = (raw.clips as Record<string, MidiClip>).beat!.notes;
    const after = (p.clips.beat as MidiClip).notes;
    for (const n of before) {
      const m = after.find((x) => x.id === n.id)!;
      if (n.pitch < 36 || n.pitch > 51) {
        expect(m.pitch).toBe(n.pitch); // not a pad: left alone
        continue;
      }
      expect(padOn(kit, m.pitch), `old note ${n.pitch}`).toEqual((v1Kit.pads as DrumPad[])[n.pitch - 36]);
      expect([m.start, m.length, m.velocity]).toEqual([n.start, n.length, n.velocity]);
    }
    // the old closed hat (41) and open hat (43) are on GM's 42 and 46 now
    expect(after.find((x) => x.id === 'n5')!.pitch).toBe(42);
    expect(after.find((x) => x.id === 'n7')!.pitch).toBe(46);
    // other tracks' notes are not drum notes
    expect((p.clips.lead as MidiClip).notes[0]!.pitch).toBe(41);
  });

  it('pad automation lanes and note sidechains follow their pads', () => {
    const p = migrateProject(v1Project());
    const [drums, bass] = p.tracks;
    expect(drums!.automation.map((l) => l.target)).toEqual([
      { kind: 'inst', param: 'p6.gain' },
      { kind: 'track', param: 'pan' },
    ]);
    expect(bass!.modulations.map((r) => r.note)).toEqual([42, null]);
  });

  it('a kit saved with missing pads gets the pads the old version filled in', () => {
    const p = migrateProject(v1Project({ pads: (v1Kit.pads as DrumPad[]).slice(0, 4) }));
    const kit = (p.tracks[0]!.instrument as { kit: DrumKit }).kit;
    expect(kit.pads.map((x) => x.name)).toEqual(defaultKit().pads.map((x) => x.name));
  });

  it('a project saved with the new layout is not moved again', () => {
    const p = migrateProject(v1Project());
    const again = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(again.clips).toEqual(p.clips);
    expect(again.tracks).toEqual(p.tracks);
  });
});

function drumSong(kit: DrumKit, pitches: number[]): Project {
  const p = createProject('Beat');
  const drums = createTrack('instrument', 0, INSTRUMENTS.drumrack.createConfig());
  (drums.instrument as { kit: DrumKit }).kit = kit;
  const clip: MidiClip = { ...createMidiClip(drums.id, 0, PPQ * 4), notes: pitches.map((pitch, i) => ({ id: `n${i}`, pitch, start: i * 120, length: 60, velocity: 100 })) };
  return { ...p, tracks: [drums], clips: { [clip.id]: clip } };
}

describe('MIDI files speak General MIDI', () => {
  it('export: every pad of the default kit is written on the GM key of its sound', () => {
    const k = defaultKit();
    const gm = kitGmNotes(k);
    const named = k.pads.map((p, i) => [p.name, gm[i]]);
    expect(Object.fromEntries(named)).toEqual({
      Kick: 36, Rim: 37, Snare: 38, Clap: 39, 'Snare Tight': 40, 'Tom Low': 41, 'Closed Hat': 42, 'Kick Short': 35,
      Shaker: 70, 'Tom Mid': 45, 'Open Hat': 46, Perc: 60, 'Tom High': 48, Crash: 49, Zap: 27, Cowbell: 56,
    });
    // no two pads share a key, so a file reads back exactly
    expect(new Set(gm).size).toBe(16);
  });

  it('export: song and clip files carry the GM keys on channel 10', () => {
    const k = defaultKit();
    const cowbell = notesOf(k, 'cowbell')[0]!;
    const shaker = notesOf(k, 'shaker')[0]!;
    const p = drumSong(k, [36, 42, cowbell, shaker, 30]);
    const song = parseMidiFile(projectToMidi(p)!);
    expect(song.tracks[0]!.channels).toEqual([9]);
    expect(song.tracks[0]!.notes.map((n) => n.pitch)).toEqual([36, 42, 56, 70, 30]);
    const clip = parseMidiFile(clipToMidi(p, Object.keys(p.clips)[0]!)!);
    expect(clip.tracks[0]!.notes.map((n) => n.pitch)).toEqual([36, 42, 56, 70, 30]);
  });

  it('import: GM keys land on the pad with that sound; keys the kit has no exact pad for go to the closest kind', () => {
    const k = defaultKit();
    const at = (gm: number) => voice(padOn(k, padNoteForGm(k, gm)));
    expect([35, 36, 38, 42, 46, 49, 56, 70].map(at)).toEqual(['kick', 'kick', 'snare', 'hatClosed', 'hatOpen', 'crash', 'cowbell', 'shaker']);
    expect(padNoteForGm(k, 35)).not.toBe(36); // the second kick
    expect(at(44)).toBe('hatClosed'); // pedal hat → closed hat
    expect(at(51)).toBe('crash'); // ride, no ride pad → crash
    // a high tom goes to the highest tom, a low one to the lowest
    const toms = notesOf(k, 'tom');
    expect(padNoteForGm(k, 50)).toBe(toms[toms.length - 1]);
    expect(padNoteForGm(k, 41)).toBe(toms[0]);
    // nothing like it in the kit: the note is kept as it is
    expect(padNoteForGm(k, 33)).toBe(33);
  });

  it('two pads of one kind away from its keys get different GM keys, and read back to each', () => {
    const k = defaultKit();
    const shaker = k.pads.findIndex((p) => voice(p) === 'shaker');
    const perc = k.pads.findIndex((p) => voice(p) === 'perc');
    k.pads[perc] = { ...k.pads[shaker]!, name: 'Shaker 2' };
    const gm = kitGmNotes(k);
    expect([gm[shaker], gm[perc]]).toEqual([70, 69]); // Maracas, then Cabasa
    expect([padNoteForGm(k, 70), padNoteForGm(k, 69)]).toEqual([36 + shaker, 36 + perc]);
  });

  it('a sample pad keeps its key both ways', () => {
    const k = defaultKit();
    k.pads[11] = { ...k.pads[11]!, source: { kind: 'sample', assetId: 'a' } };
    expect(kitGmNotes(k)[11]).toBe(47);
    expect(padNoteForGm(k, 47)).toBe(47);
  });

  it('export → import gives the same notes back, for every factory kit', () => {
    for (const { name, kit } of FACTORY_KITS) {
      const gm = kitGmNotes(kit);
      for (let i = 0; i < 16; i++) {
        // kits with two pads of the same kind can share a GM key; then the first pad gets it back
        const first = gm.indexOf(gm[i]!);
        expect(padNoteForGm(kit, gm[i]!), `${name} pad ${i}`).toBe(36 + first);
      }
    }
  });

  it('dropping a GM drum file creates a Drum Rack whose pads play the right sounds', async () => {
    const { importMidiFiles } = await import('../src/ui/actions');
    useProjectStore.getState().loadProject({ ...createProject(), tracks: [], clips: {} });
    const bytes = writeMidiFile({
      ppq: 480,
      bpm: 120,
      tracks: [{ name: 'Groove', channel: 9, notes: [36, 42, 46, 51, 56].map((pitch, i) => ({ pitch, start: i * 240, length: 60, velocity: 100 })) }],
    });
    await importMidiFiles([new File([bytes as BlobPart], 'groove.mid')]);
    const p = useProjectStore.getState().project;
    const t = p.tracks[0]!;
    const kit = (t.instrument as { kit: DrumKit }).kit;
    const notes = (Object.values(p.clips)[0] as MidiClip).notes;
    expect(notes.map((n) => voice(padOn(kit, n.pitch)))).toEqual(['kick', 'hatClosed', 'hatOpen', 'crash', 'cowbell']);
  });

  it('dropping a GM drum file into a Drum Rack clip maps it too', async () => {
    const { importMidiIntoClip } = await import('../src/ui/actions');
    const p = drumSong(defaultKit(), []);
    useProjectStore.getState().loadProject(p);
    const clipId = Object.keys(p.clips)[0]!;
    const bytes = writeMidiFile({ ppq: 480, bpm: 120, tracks: [{ name: 'Hats', channel: 9, notes: [{ pitch: 42, start: 0, length: 60, velocity: 100 }, { pitch: 70, start: 240, length: 60, velocity: 100 }] }] });
    await importMidiIntoClip(new File([bytes as BlobPart], 'hats.mid'), clipId, 0);
    const clip = useProjectStore.getState().project.clips[clipId] as MidiClip;
    const kit = defaultKit();
    expect(clip.notes.map((n) => voice(padOn(kit, n.pitch)))).toEqual(['hatClosed', 'shaker']);
  });
});
