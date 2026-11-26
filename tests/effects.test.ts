import { describe, expect, it } from 'vitest';
import {
  createEffectSlot,
  defaultParams,
  delayTimeSeconds,
  effectTailSeconds,
  FACTORY_EFFECT_PRESETS,
  mixGains,
  sanitizeEffect,
} from '../src/audio/effects/specs';
import { generateImpulse } from '../src/audio/effects/impulse';
import { addEffectSlot, moveEffectSlot, removeEffectSlot, withParams } from '../src/project/effectOps';
import { createProject } from '../src/project/defaults';
import { migrateProject } from '../src/project/migrations';
import type { EffectSlot } from '../src/project/types';
import { dbToPos, posToDb } from '../src/ui/mixer/VFader';

describe('effect parameters', () => {
  it('syncs delay time to tempo', () => {
    const p = { ...defaultParams('delay'), sync: true, division: 0.75 };
    expect(delayTimeSeconds(p, 120)).toBeCloseTo(0.375, 9);
    expect(delayTimeSeconds({ ...p, division: 1 }, 90)).toBeCloseTo(60 / 90, 9);
    expect(delayTimeSeconds({ ...p, sync: false, time: 0.123 }, 120)).toBeCloseTo(0.123, 9);
    expect(delayTimeSeconds({ ...p, division: 4 }, 20)).toBe(4); // clamped to the max delay line
  });

  it('uses equal-power wet/dry mixing', () => {
    for (const m of [0, 0.25, 0.5, 1]) {
      const g = mixGains(m);
      expect(g.dry ** 2 + g.wet ** 2).toBeCloseTo(1, 9);
    }
    expect(mixGains(0)).toEqual({ dry: 1, wet: 0 });
  });

  it('sanitizes untrusted effect data', () => {
    const e = sanitizeEffect({ type: 'compressor', params: { threshold: -500, ratio: 99, attack: 'x' } });
    expect(e?.type).toBe('compressor');
    expect(e?.params).toMatchObject({ threshold: -60, ratio: 20, attack: 0.01 });
    expect(sanitizeEffect({ type: 'flanger' })).toBeNull();
    expect(sanitizeEffect({ type: 'delay', params: { division: 0.33 } })?.params).toMatchObject({ division: 0.75 });
    const r = sanitizeEffect({ type: 'reverb', enabled: false, params: { decay: 3 } });
    expect(r?.enabled).toBe(false);
  });

  it('estimates effect tails for export', () => {
    const d = createEffectSlot('delay');
    if (d.type !== 'delay') throw new Error();
    const tail = effectTailSeconds({ ...d, params: { ...d.params, feedback: 0.5, sync: false, time: 0.5 } }, 120);
    expect(tail).toBeGreaterThan(4); // 0.5 s × ~10 repeats until -60 dB
    expect(effectTailSeconds({ ...createEffectSlot('reverb'), enabled: false }, 120)).toBe(0);
    expect(effectTailSeconds(createEffectSlot('eq'), 120)).toBe(0);
  });

  it('factory presets are valid for their effect type', () => {
    for (const p of FACTORY_EFFECT_PRESETS) {
      const s = sanitizeEffect({ type: p.type, params: p.params });
      expect(s?.params, p.name).toEqual(p.params);
    }
  });
});

describe('reverb impulse', () => {
  it('is deterministic, stereo-decorrelated and decays ~60 dB by the decay time', () => {
    const sr = 48000;
    const [l, r] = generateImpulse(sr, 2);
    const [l2] = generateImpulse(sr, 2);
    expect(l).toEqual(l2);
    expect(l.length).toBe(Math.round((2 + 0.05) * sr));
    let diff = 0;
    for (let i = 0; i < 2000; i++) diff += Math.abs((l[i] as number) - (r[i] as number));
    expect(diff).toBeGreaterThan(1);
    const rms = (a: Float32Array, from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += (a[i] as number) ** 2;
      return Math.sqrt(s / (to - from));
    };
    const early = rms(l, 0.1 * sr, 0.2 * sr);
    const atDecay = rms(l, 1.9 * sr, 2.0 * sr);
    expect(20 * Math.log10(atDecay / early)).toBeLessThan(-45);
    expect(Math.abs(l[0] as number)).toBe(0); // faded in, no click
  });
});

describe('effect chain operations', () => {
  const chain = (): EffectSlot[] => [createEffectSlot('eq'), createEffectSlot('compressor'), createEffectSlot('delay')];

  it('adds up to four slots', () => {
    let c = chain();
    const four = addEffectSlot(c, createEffectSlot('reverb'));
    expect(four).toHaveLength(4);
    c = four as EffectSlot[];
    expect(addEffectSlot(c, createEffectSlot('eq'))).toBeNull();
  });

  it('inserts at an index, reorders and removes', () => {
    const c = chain();
    const r = createEffectSlot('reverb');
    const ins = addEffectSlot(c, r, 0) as EffectSlot[];
    expect(ins[0]?.id).toBe(r.id);
    const moved = moveEffectSlot(ins, r.id, 2);
    expect(moved.map((s) => s.type)).toEqual(['eq', 'compressor', 'reverb', 'delay']);
    expect(moveEffectSlot(moved, r.id, -10)[0]?.id).toBe(r.id);
    expect(moveEffectSlot(moved, 'missing', 1)).toBe(moved);
    expect(removeEffectSlot(moved, r.id).map((s) => s.type)).toEqual(['eq', 'compressor', 'delay']);
  });

  it('merges params without losing the slot type', () => {
    const s = withParams(createEffectSlot('eq'), { lowGain: 4 });
    expect(s.type).toBe('eq');
    expect(s.params).toMatchObject({ lowGain: 4, midFreq: 1000 });
  });

  it('effect chains persist through project serialization', () => {
    const p = createProject();
    const t = p.tracks[0];
    if (!t) throw new Error();
    t.effects = [withParams(createEffectSlot('reverb'), { decay: 4.5 }), { ...createEffectSlot('delay'), enabled: false }];
    const back = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(back.tracks[0]?.effects).toEqual(t.effects);
  });
});

describe('fader law', () => {
  it('round-trips dB ↔ position and puts 0 dB high on the fader', () => {
    for (const db of [-60, -24, -6, 0, 3, 6]) expect(posToDb(dbToPos(db))).toBeCloseTo(db, 6);
    expect(dbToPos(0)).toBeGreaterThan(0.75);
    expect(dbToPos(0)).toBeLessThan(0.85);
    expect(dbToPos(-100)).toBe(0);
    expect(dbToPos(20)).toBe(1);
  });
});

describe('compressor makeup compensation', () => {
  it('cancels the Web Audio automatic makeup gain (0.6 × full-range gain)', async () => {
    const { autoMakeupCompensationDb } = await import('../src/audio/effects/units');
    expect(autoMakeupCompensationDb(-30, 10)).toBeCloseTo(-16.2, 6);
    expect(autoMakeupCompensationDb(0, 4)).toBeCloseTo(0, 9);
    expect(autoMakeupCompensationDb(-20, 1)).toBeCloseTo(0, 9);
  });
});

describe('master effects', () => {
  it('a new project has an empty master chain; saved chains are sanitized and capped at 4', async () => {
    const { createEffectSlot } = await import('../src/audio/effects/specs');
    expect(createProject().master.effects).toEqual([]);
    const p = createProject();
    const raw = JSON.parse(JSON.stringify({ ...p, master: { volumeDb: -2, limiter: true, effects: [createEffectSlot('compressor'), { type: 'bogus' }, createEffectSlot('eq'), createEffectSlot('peq'), createEffectSlot('reverb'), createEffectSlot('delay')] } }));
    const m = migrateProject(raw);
    expect(m.master.effects.map((e) => e.type)).toEqual(['compressor', 'eq', 'peq', 'reverb']);
    // older projects without the field
    const old = JSON.parse(JSON.stringify({ ...p, master: { volumeDb: 0, limiter: false } }));
    expect(migrateProject(old).master).toEqual({ volumeDb: 0, limiter: false, effects: [] });
  });

  it('master effects are added, edited, bypassed and removed through the same commands as track effects (undoable)', async () => {
    const { useProjectStore } = await import('../src/state/projectStore');
    const fx = await import('../src/state/effectActions');
    const { MASTER_ID } = await import('../src/project/types');
    useProjectStore.getState().loadProject(createProject());
    const comp = fx.addEffect(MASTER_ID, 'compressor');
    expect(comp).not.toBeNull();
    fx.setEffectParams(MASTER_ID, comp!.id, { ratio: 2 });
    fx.setEffectEnabled(MASTER_ID, comp!.id, false);
    let m = useProjectStore.getState().project.master;
    expect(m.effects[0]).toMatchObject({ type: 'compressor', enabled: false, params: { ratio: 2 } });
    for (let i = 0; i < 3; i++) fx.addEffect(MASTER_ID, 'eq');
    expect(fx.addEffect(MASTER_ID, 'eq')).toBeNull(); // 4 max
    fx.removeEffect(MASTER_ID, comp!.id);
    m = useProjectStore.getState().project.master;
    expect(m.effects.map((e) => e.type)).toEqual(['eq', 'eq', 'eq']);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.master.effects).toHaveLength(4);
  });

  it('a reverb on the master lengthens the export tail', async () => {
    const { createEffectSlot } = await import('../src/audio/effects/specs');
    const { estimateTailSeconds } = await import('../src/audio/exportPlan');
    const p = createProject();
    const dry = estimateTailSeconds(p, () => true);
    const wet = estimateTailSeconds({ ...p, master: { ...p.master, effects: [createEffectSlot('reverb')] } }, () => true);
    expect(wet).toBeGreaterThan(dry + 1);
  });
});

describe('send channels', () => {
  it('new projects have Send A (reverb) and Send B (delay), fully wet; tracks start at 0', async () => {
    const { SEND_IDS, sendLabel } = await import('../src/project/types');
    const { EFFECT_LABELS } = await import('../src/audio/effects/specs');
    const p = createProject();
    expect(p.sends.map((b) => b.id)).toEqual([...SEND_IDS]);
    expect(p.sends.map((b) => b.effects.map((e) => e.type))).toEqual([['reverb'], ['delay']]);
    expect(p.sends.every((b) => b.effects[0]!.params && (b.effects[0]!.params as { mix: number }).mix === 1)).toBe(true);
    expect(p.tracks.every((t) => t.sends.every((v) => v === 0))).toBe(true);
    expect(sendLabel(p.sends[0]!, (t) => EFFECT_LABELS[t])).toBe('A · Reverb');
    expect(sendLabel({ ...p.sends[1]!, effects: [] }, (t) => EFFECT_LABELS[t])).toBe('B · empty');
  });

  it('older projects get both send channels and zero sends; saved ones are sanitized', () => {
    const p = createProject();
    const old = JSON.parse(JSON.stringify(p));
    delete old.sends;
    for (const t of old.tracks) delete t.sends;
    const m = migrateProject(old);
    expect(m.sends).toHaveLength(2);
    expect(m.tracks.every((t) => t.sends.length === 2 && t.sends.every((v) => v === 0))).toBe(true);
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks[0].sends = [2, -1];
    raw.sends[1] = { id: '__sendB__', name: 'Echo', volumeDb: 99, mute: true, effects: [{ type: 'nope' }] };
    const s = migrateProject(raw);
    expect(s.tracks[0]!.sends).toEqual([1, 0]);
    expect(s.sends[1]).toMatchObject({ name: 'Echo', volumeDb: 6, mute: true, effects: [] });
  });

  it('send levels, send-channel fader/mute and their effects are undoable edits', async () => {
    const { useProjectStore } = await import('../src/state/projectStore');
    const fx = await import('../src/state/effectActions');
    const { SEND_IDS } = await import('../src/project/types');
    useProjectStore.getState().loadProject(createProject());
    const tid = useProjectStore.getState().project.tracks[1]!.id;
    fx.setTrackSend(tid, 0, 0.7);
    fx.updateSendBus(1, { mute: true, volumeDb: -3 }, 'x');
    const ch = fx.addEffect(SEND_IDS[0], 'chorus');
    let p = useProjectStore.getState().project;
    expect(p.tracks[1]!.sends).toEqual([0.7, 0]);
    expect(p.sends[1]).toMatchObject({ mute: true, volumeDb: -3 });
    expect(p.sends[0]!.effects.map((e) => e.type)).toEqual(['reverb', 'chorus']);
    fx.removeEffect(SEND_IDS[0], ch!.id);
    useProjectStore.getState().undo();
    useProjectStore.getState().undo();
    p = useProjectStore.getState().project;
    expect(p.sends[0]!.effects).toHaveLength(1);
  });

  it('a send to a reverb lengthens the export tail only while some audible track uses it', async () => {
    const { estimateTailSeconds } = await import('../src/audio/exportPlan');
    const p = createProject();
    const base = estimateTailSeconds(p, () => true);
    const sending = { ...p, tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, sends: [0.5, 0] } : t)) };
    expect(estimateTailSeconds(sending, () => true)).toBeGreaterThan(base + 1);
    expect(estimateTailSeconds(sending, () => false)).toBeLessThan(base + 0.5);
    expect(estimateTailSeconds({ ...sending, sends: sending.sends.map((b, k) => (k === 0 ? { ...b, mute: true } : b)) }, () => true)).toBeLessThan(base + 0.5);
  });
});
