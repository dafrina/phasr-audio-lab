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
