import { describe, expect, it } from 'vitest';
import { DRUM_BASE_NOTE, DRUM_PADS, DRUM_VOICES, FACTORY_KITS, defaultKit, kitAssetIds, padIndexForNote, sanitizeKit } from '../src/drums/kit';
import { renderDrumVoice } from '../src/drums/synth';
import { INSTRUMENTS, INSTRUMENT_TYPES, noteLabelFor, sanitizeInstrument, sidechainNoteFor } from '../src/instruments/definitions';
import { createProject, createTrack } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import type { DrumPadSource } from '../src/project/types';
import { duckFrom } from '../src/state/modulationActions';
import { useProjectStore } from '../src/state/projectStore';

const SR = 48000;
type Synth = Extract<DrumPadSource, { kind: 'synth' }>;

function zeroCrossRate(a: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (((a[i - 1] as number) <= 0) !== ((a[i] as number) <= 0)) n++;
  return (n * SR) / (2 * (to - from));
}

describe('drum synthesis', () => {
  it('renders every voice: finite, normalized to -1 dBFS, deterministic, length ≈ requested', () => {
    for (const v of DRUM_VOICES) {
      const src: Synth = { kind: 'synth', voice: v.type, tone: 0.5, snap: 0.5, length: 0.3 };
      const a = renderDrumVoice(src, SR);
      const b = renderDrumVoice(src, SR);
      expect(a, v.type).toEqual(b);
      expect(a.every(Number.isFinite), v.type).toBe(true);
      let pk = 0;
      for (const x of a) pk = Math.max(pk, Math.abs(x));
      expect(pk, v.type).toBeCloseTo(0.89, 2);
      expect(a.length / SR, v.type).toBeGreaterThan(0.3);
      expect(a.length / SR, v.type).toBeLessThan(0.45);
      expect(Math.abs(a[0] as number), v.type).toBe(0); // faded in, no click
    }
  });

  it('kick sweeps down in pitch; hats are much brighter than kicks; tone raises the tom', () => {
    const kick = renderDrumVoice({ kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.6, length: 0.5 }, SR);
    expect(zeroCrossRate(kick, 0, 480)).toBeGreaterThan(zeroCrossRate(kick, 9600, 14400) * 1.5);
    const hat = renderDrumVoice({ kind: 'synth', voice: 'hatClosed', tone: 0.5, snap: 0.5, length: 0.08 }, SR);
    expect(zeroCrossRate(hat, 0, 2000)).toBeGreaterThan(zeroCrossRate(kick, 0, 2000) * 10);
    const lo = renderDrumVoice({ kind: 'synth', voice: 'tom', tone: 0.1, snap: 0.3, length: 0.4 }, SR);
    const hi = renderDrumVoice({ kind: 'synth', voice: 'tom', tone: 0.9, snap: 0.3, length: 0.4 }, SR);
    expect(zeroCrossRate(hi, 4800, 9600)).toBeGreaterThan(zeroCrossRate(lo, 4800, 9600) * 1.5);
  });
});

describe('drum kit model', () => {
  it('has 16 pads on notes 36..51 with hats in a choke group', () => {
    const k = defaultKit();
    expect(k.pads).toHaveLength(DRUM_PADS);
    expect(padIndexForNote(DRUM_BASE_NOTE)).toBe(0);
    expect(padIndexForNote(51)).toBe(15);
    expect(padIndexForNote(52)).toBe(-1);
    const hats = k.pads.filter((p) => p.name.includes('Hat'));
    expect(new Set(hats.map((h) => h.choke))).toEqual(new Set([1]));
    expect(FACTORY_KITS.length).toBeGreaterThanOrEqual(3);
  });

  it('sanitizes kits, keeps sample pads, and lists their assets', () => {
    const raw = { pads: [{ name: 'My Kick', source: { kind: 'sample', assetId: 'ast_1' }, gain: 99, tune: -50, choke: 9 }, { source: { kind: 'synth', voice: 'nope' } }] };
    const k = sanitizeKit(raw);
    expect(k.pads[0]).toMatchObject({ name: 'My Kick', source: { kind: 'sample', assetId: 'ast_1' }, gain: 12, tune: -24, choke: 4 });
    expect(k.pads[1]?.source).toEqual(defaultKit().pads[1]?.source); // invalid voice → default
    expect(k.pads).toHaveLength(16);
    expect(kitAssetIds(k)).toEqual(['ast_1']);
  });
});

describe('instrument registry', () => {
  it('every registered type creates, validates and round-trips its config', () => {
    for (const type of INSTRUMENT_TYPES) {
      const def = INSTRUMENTS[type];
      const cfg = def.createConfig();
      expect(cfg.type).toBe(type);
      expect(sanitizeInstrument(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
      expect(typeof def.label).toBe('string');
    }
    expect(sanitizeInstrument({ type: 'theremin' }).type).toBe('triosc');
  });

  it('labels drum notes with pad names and defaults sidechains to the kick pad', () => {
    const drums = INSTRUMENTS.drumrack.createConfig();
    expect(noteLabelFor(drums, 36)).toBe('Kick');
    expect(noteLabelFor(drums, 38)).toBe('Snare');
    expect(noteLabelFor(drums, 60)).toBeNull();
    expect(noteLabelFor(INSTRUMENTS.triosc.createConfig(), 36)).toBeNull();
    expect(sidechainNoteFor(drums)).toBe(36);
    expect(sidechainNoteFor(INSTRUMENTS.triosc.createConfig())).toBeNull();
  });

  it('a drum rack track survives project save/load', () => {
    const p = createProject();
    const t = createTrack('instrument', 2, INSTRUMENTS.drumrack.createConfig());
    expect(t.name).toBe('Drums 3');
    if (t.instrument?.type !== 'drumrack') throw new Error();
    t.instrument.kit.pads[0] = { ...t.instrument.kit.pads[0]!, source: { kind: 'sample', assetId: 'ast_k' }, name: 'Big Kick' };
    p.tracks.push(t);
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[2]?.instrument).toEqual(t.instrument);
  });

  it('“Duck from” a drum rack listens to its kick pad only', () => {
    const p = createProject();
    const drums = createTrack('instrument', 2, INSTRUMENTS.drumrack.createConfig());
    p.tracks.push(drums);
    useProjectStore.getState().loadProject(p);
    const bass = p.tracks[1]!;
    duckFrom(bass.id, drums.id);
    const r = useProjectStore.getState().project.tracks.find((x) => x.id === bass.id)?.modulations[0];
    expect(r).toMatchObject({ source: 'midi', note: 36, depth: -12, target: { kind: 'track', param: 'volumeDb' } });
  });
});

describe('per-pad EQ, pad sends and split to own track', () => {
  const setup = () => {
    const p = createProject();
    const drums = createTrack('instrument', 0, INSTRUMENTS.drumrack.createConfig());
    drums.name = 'Drums';
    const notes = [
      { id: 'k1', pitch: DRUM_BASE_NOTE, start: 0, length: 100, velocity: 120 },
      { id: 'h1', pitch: DRUM_BASE_NOTE + 6, start: 240, length: 60, velocity: 90 },
      { id: 'k2', pitch: DRUM_BASE_NOTE, start: 960, length: 100, velocity: 110 },
    ];
    const clip = { id: 'c1', kind: 'midi' as const, trackId: drums.id, name: 'Beat', start: 0, length: 3840, loopLength: 3840, loop: false, notes };
    useProjectStore.getState().loadProject({ ...p, tracks: [drums], clips: { c1: clip } });
    return drums.id;
  };

  it('a pad EQ and pad sends survive save/load; junk is dropped', () => {
    const kit = defaultKit();
    const raw = JSON.parse(JSON.stringify({ pads: kit.pads.map((pd, i) => (i === 0 ? { ...pd, eq: { id: 'e', type: 'peq', enabled: true, params: { bands: [], output: 2 } }, sends: [0.5, 9] } : i === 1 ? { ...pd, eq: { type: 'reverb' } } : pd)) }));
    const k = sanitizeKit(raw);
    expect(k.pads[0]?.eq?.type).toBe('peq');
    expect(k.pads[0]?.eq?.params.output).toBe(2);
    expect(k.pads[0]?.sends).toEqual([0.5, 1]);
    expect(k.pads[1]?.eq).toBeNull();
    expect(k.pads[2]?.sends).toEqual([0, 0]);
  });

  it('a pad gets exactly one Spectra EQ through the normal effect commands (undoable)', async () => {
    const fx = await import('../src/state/effectActions');
    const { padChainId } = await import('../src/project/types');
    const tid = setup();
    const id = padChainId(tid, 0);
    expect(fx.addEffect(id, 'peq')).not.toBeNull();
    expect(fx.addEffect(id, 'peq')).toBeNull(); // one per pad
    expect(fx.addEffect(padChainId(tid, 1), 'reverb')).toBeNull(); // EQ only
    const pad0 = () => {
      const i = useProjectStore.getState().project.tracks[0]!.instrument;
      return i?.type === 'drumrack' ? i.kit.pads[0] : undefined;
    };
    const slot = pad0()!.eq!;
    fx.setEffectEnabled(id, slot.id, false);
    expect(pad0()!.eq!.enabled).toBe(false);
    fx.setPadSend(tid, 0, 1, 0.6);
    expect(pad0()!.sends).toEqual([0, 0.6]);
    fx.removeEffect(id, slot.id);
    expect(pad0()!.eq).toBeNull();
    useProjectStore.getState().undo();
    expect(pad0()!.eq?.type).toBe('peq');
  });

  it('split to own track moves that pad’s notes, its EQ (as an insert) and its sends — one undo', async () => {
    const fx = await import('../src/state/effectActions');
    const { padChainId } = await import('../src/project/types');
    const { splitPadToTrack } = await import('../src/ui/actions');
    const tid = setup();
    fx.addEffect(padChainId(tid, 0), 'peq');
    fx.setPadSend(tid, 0, 0, 0.4);
    splitPadToTrack(tid, 0);
    const p = useProjectStore.getState().project;
    expect(p.tracks.map((t) => t.name)).toEqual(['Drums', p.tracks[1]!.name]);
    const kick = p.tracks[1]!;
    expect(kick.instrument?.type).toBe('drumrack');
    expect(kick.effects.map((e) => e.type)).toEqual(['peq']);
    expect(kick.sends).toEqual([0.4, 0]);
    const clips = Object.values(p.clips) as { trackId: string; notes: { pitch: number }[] }[];
    const onKick = clips.filter((c) => c.trackId === kick.id).flatMap((c) => c.notes);
    const onDrums = clips.filter((c) => c.trackId === tid).flatMap((c) => c.notes);
    expect(onKick.map((n) => n.pitch)).toEqual([DRUM_BASE_NOTE, DRUM_BASE_NOTE]);
    expect(onDrums.map((n) => n.pitch)).toEqual([DRUM_BASE_NOTE + 6]);
    useProjectStore.getState().undo();
    const back = useProjectStore.getState().project;
    expect(back.tracks).toHaveLength(1);
    expect((Object.values(back.clips)[0] as { notes: unknown[] }).notes).toHaveLength(3);
  });
});

describe('split to own track takes what belongs to the pad along', () => {
  it('its sidechain routes, its automation and the reverb it got through the track send move with it', async () => {
    const { createRoute } = await import('../src/project/modulation');
    const { splitPadToTrack } = await import('../src/ui/actions');
    const { createLane } = await import('../src/project/automation');
    const p = createProject();
    const drums = createTrack('instrument', 0, INSTRUMENTS.drumrack.createConfig());
    drums.name = 'Drums';
    drums.sends = [0.5, 0];
    drums.automation = [
      { ...createLane({ kind: 'inst', param: 'p0.tune' }, 0, 0), points: [{ id: 'a', tick: 0, value: 0 }, { id: 'b', tick: 3840, value: -5 }] },
      { ...createLane({ kind: 'inst', param: 'p6.gain' }, 0, 0), points: [{ id: 'c', tick: 0, value: -3 }] },
    ];
    drums.instrument = { ...(drums.instrument as any), kit: { pads: (drums.instrument as any).kit.pads.map((pd: any, i: number) => (i === 0 ? { ...pd, sends: [0.25, 0] } : pd)) } };
    const bass = createTrack('instrument', 1, INSTRUMENTS.triosc.createConfig());
    // "Duck from Drums": listens to the kick note; a second route listens to every hit
    const kickDuck = { ...createRoute(bass, drums.id, 'midi', { kind: 'track', param: 'volumeDb' })!, note: DRUM_BASE_NOTE };
    const anyHit = { ...createRoute(bass, drums.id, 'midi', { kind: 'track', param: 'pan' })!, note: null };
    bass.modulations = [kickDuck, anyHit];
    const notes = [
      { id: 'k1', pitch: DRUM_BASE_NOTE, start: 0, length: 100, velocity: 120 },
      { id: 'h1', pitch: DRUM_BASE_NOTE + 6, start: 240, length: 60, velocity: 90 },
    ];
    const clip = { id: 'c1', kind: 'midi' as const, trackId: drums.id, name: 'Beat', start: 0, length: 3840, loopLength: 3840, loop: false, notes };
    useProjectStore.getState().loadProject({ ...p, tracks: [drums, bass], clips: { c1: clip } });

    splitPadToTrack(drums.id, 0);
    const after = useProjectStore.getState().project;
    const kick = after.tracks[1]!;
    const d = after.tracks[0]!;
    const b = after.tracks[2]!;
    // the kick reached Send A through its pad send (0.25) and the Drums send (0.5): it still does
    expect(kick.sends).toEqual([0.75, 0]);
    // the kick-note duck now listens to the kick track; the any-hit route stays on Drums
    expect(b.modulations.map((r) => [r.sourceTrackId, r.note])).toEqual([[kick.id, DRUM_BASE_NOTE], [drums.id, null]]);
    // the kick pad's lane went with it; the other pad's lane stayed
    expect(kick.automation.map((l) => (l.target as { param: string }).param)).toEqual(['p0.tune']);
    expect(kick.automation[0]!.points.map((x) => x.value)).toEqual([0, -5]);
    expect(d.automation.map((l) => (l.target as { param: string }).param)).toEqual(['p6.gain']);
    // one undo puts everything back
    useProjectStore.getState().undo();
    const back = useProjectStore.getState().project;
    expect(back.tracks.map((t) => t.id)).toEqual([drums.id, bass.id]);
    expect(back.tracks[1]!.modulations.map((r) => r.sourceTrackId)).toEqual([drums.id, drums.id]);
    expect(back.tracks[0]!.automation).toHaveLength(2);
  });
});

describe('drum voice styles (Classic + House / Techno / Hip-Hop / Trap / Lo-Fi, per pad)', () => {
  it('every voice offers six styles; each renders clean, full-level and different from the classic one', async () => {
    const { DRUM_MODELS } = await import('../src/drums/kit');
    for (const v of DRUM_VOICES) {
      const models = DRUM_MODELS[v.type];
      expect(models.length, v.type).toBe(6);
      const classic = renderDrumVoice({ kind: 'synth', voice: v.type, tone: 0.5, snap: 0.5, length: 0.4, model: 0 }, 48000);
      for (let m = 1; m < models.length; m++) {
        const x = renderDrumVoice({ kind: 'synth', voice: v.type, tone: 0.5, snap: 0.5, length: 0.4, model: m }, 48000);
        expect(x.every((s) => Number.isFinite(s)), `${v.type}/${models[m]}`).toBe(true);
        const pk = x.reduce((a, s) => Math.max(a, Math.abs(s)), 0);
        expect(pk, `${v.type}/${models[m]} peak`).toBeGreaterThan(0.8);
        expect(pk).toBeLessThanOrEqual(0.9);
        // a genuinely different sound, not the classic one
        let diff = 0;
        for (let i = 0; i < Math.min(x.length, classic.length); i++) diff += ((x[i] as number) - (classic[i] as number)) ** 2;
        expect(diff, `${v.type}/${models[m]} differs`).toBeGreaterThan(1);
      }
    }
  });

  it('a pad without a character (older projects) is the classic sound; saved characters are clamped', () => {
    const a = renderDrumVoice({ kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.5, length: 0.4 }, 48000);
    const b = renderDrumVoice({ kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.5, length: 0.4, model: 0 }, 48000);
    expect(Array.from(a)).toEqual(Array.from(b));
    const k = sanitizeKit({ pads: [{ name: 'K', source: { kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.5, length: 0.4, model: 9 } }, { name: 'S', source: { kind: 'synth', voice: 'snare', tone: 0.5, snap: 0.5, length: 0.4 } }] });
    expect(k.pads[0]?.source).toMatchObject({ model: 5 });
    expect(k.pads[1]?.source).toMatchObject({ model: 0 });
  });

  it('one kit per style: House, Techno and Hip-Hop kits are built from that style', () => {
    for (const [name, model] of [['House Kit', 1], ['Techno Kit', 2], ['Hip-Hop Kit', 3], ['Trap Kit', 4], ['Lo-Fi Kit', 5]] as const) {
      const k = FACTORY_KITS.find((x) => x.name === name)?.kit;
      expect(k, name).toBeTruthy();
      expect(k!.pads.filter((p) => p.source.kind === 'synth' && p.source.model === model).length, name).toBeGreaterThanOrEqual(12);
    }
  });
});
