/**
 * How much garbage each DSP core's per-block processing makes, measured with
 * V8's sampling heap profiler (every allocation, including short-lived ones a
 * minor GC reclaims), over 4000 blocks of 128 frames after a warm-up, with a
 * busy score: chords past the polyphony limit (voice steals), sustain, bends.
 *
 * Findings (see README › Performance): the effect cores (phaser, Lo-Fi, auto
 * gain, modulation source) allocate nothing. The instrument cores and Reverb
 * Lite allocate no buffers or objects of their own, but V8 boxes floating-point
 * values passed to (or returned from) functions it does not inline, e.g. the
 * two samples handed to FdnReverb.process() on every frame (exactly 32 B per
 * sample in Reverb Lite), plus iterator objects from for…of over voices. The
 * young-generation GC reclaims these cheaply, but it is garbage on the audio
 * thread. The budgets below are the measured values + 50 %: they catch a
 * regression (an allocation added to a per-sample path) and get lowered when
 * an engine is made allocation-free.
 */
import { Session } from 'node:inspector/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TriOscCore, type SynthEvent } from '../src/synth/dsp/TriOscCore';
import { KeysCore } from '../src/keys/dsp/KeysCore';
import { defaultKeysParams, type KeysEngineType } from '../src/keys/params';
import { RoomCore } from '../src/audio/room/RoomCore';
import { PhaserCore } from '../src/audio/phaser/PhaserCore';
import { ModSourceCore } from '../src/audio/modsource/ModSourceCore';
import { CrushCore } from '../src/audio/saturator/CrushCore';
import { AutoGainCore } from '../src/audio/saturator/AutoGainCore';
import { FACTORY_PRESETS } from '../src/synth/presets';

const SR = 48000;
const B = 128;
const WARM = 2000;
const BLOCKS = 4000;
const session = new Session();
beforeAll(() => session.connect());
afterAll(() => session.disconnect());

/** bytes allocated per block by `step`, after a warm-up (so the code is optimised as in a long session) */
async function bytesPerBlock(step: (block: number) => void): Promise<number> {
  for (let b = 0; b < WARM; b++) step(b);
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let b = WARM; b < WARM + BLOCKS; b++) step(b);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  // only what the DSP code allocated (not the profiler's own bookkeeping)
  let bytes = 0;
  const walk = (n: typeof profile.head, inDsp: boolean) => {
    const here = inDsp || /\/src\/|allocation\.perf/.test(n.callFrame.url);
    if (here) bytes += n.selfSize;
    for (const c of n.children) walk(c, here);
  };
  walk(profile.head, false);
  return bytes / BLOCKS;
}

function score(seconds: number): SynthEvent[] {
  const ev: SynthEvent[] = [];
  let id = 1;
  for (let t = 0; t < seconds; t += 0.125) {
    for (const x of [0, 3, 7, 10, 14, 17, 21, 24]) {
      const note = 36 + ((Math.round(t * 8) * 5) % 24) + x;
      ev.push({ type: 'noteOn', time: t, id, note, velocity: 0.4 + ((id * 37) % 60) / 100 });
      ev.push({ type: 'noteOff', time: t + 0.3, id: id++ });
    }
  }
  for (let t = 0; t < seconds; t += 1) {
    ev.push({ type: 'sustain', time: t + 0.5, on: true }, { type: 'sustain', time: t + 0.9, on: false });
    ev.push({ type: 'bend', time: t + 0.2, value: 0.5 }, { type: 'bend', time: t + 0.6, value: 0 });
  }
  return ev.sort((a, b) => a.time - b.time);
}
const SECONDS = ((WARM + BLOCKS) * B) / SR + 1;

const report: string[] = [];
afterAll(() => console.log(`\nallocation per 128-frame block:\n${report.join('\n')}`));
const check = (name: string, perBlock: number, budget: number) => {
  report.push(`  ${name.padEnd(12)} ${perBlock.toFixed(0).padStart(6)} B  (budget ${budget})`);
  expect(perBlock, `${name}: ${perBlock.toFixed(1)} B per block`).toBeLessThan(budget);
};

describe('DSP allocation per block', () => {
  const l = new Float32Array(B);
  const r = new Float32Array(B);

  it('TriOsc', async () => {
    const core = new TriOscCore(SR, FACTORY_PRESETS[0]!.patch);
    core.handleMessage({ type: 'events', events: score(SECONDS) });
    check('triosc', await bytesPerBlock((b) => core.process(b * B, l, r)), 5000);
  }, 60_000);

  const KEYS_BUDGET: Record<KeysEngineType, number> = { piano: 110_000, epiano: 7000, organ: 60_000, analog: 70_000, sub808: 3300 };
  for (const engine of Object.keys(KEYS_BUDGET) as KeysEngineType[]) {
    it(`Keys: ${engine}`, async () => {
      const core = new KeysCore(SR, { engine, params: defaultKeysParams(engine) });
      core.handleMessage({ type: 'events', events: score(SECONDS) });
      check(engine, await bytesPerBlock((b) => core.process(b * B, l, r)), KEYS_BUDGET[engine]);
    }, 60_000);
  }

  const x = new Float32Array(B);
  const fill = (b: number) => {
    for (let i = 0; i < B; i++) x[i] = Math.sin((b * B + i) * 0.031) * 0.5 + (((b * 131 + i * 17) % 97) / 97 - 0.5) * 0.2;
  };

  it('Reverb Lite (two boxed samples per frame into the FDN)', async () => {
    const room = new RoomCore(SR);
    const p = { decay: 2.4, decayShift: 0.2, size: 1, tone: 6000 };
    check('room', await bytesPerBlock((b) => (fill(b), room.process(x, x, l, r, p))), 6500);
  });

  it('effect cores that allocate nothing: phaser, Lo-Fi, auto gain, modulation source', async () => {
    const phaser = new PhaserCore(SR, 8);
    const pp = { rate: 0.7, depth: 0.8, center: 900, shift: 0.1, feedback: 0.6, stereo: 0.5 };
    const crush = new CrushCore(SR);
    const gain = new AutoGainCore(SR);
    const mod = new ModSourceCore(SR, { mode: 'audio', attack: 0.005, release: 0.1, threshold: -30, hold: 0.02, invert: false });
    const out = new Float32Array(B);
    // (sampling at 32 B: a few bytes per block is sampling noise, one object per block is ≥ 16)
    check('phaser', await bytesPerBlock((b) => (fill(b), phaser.process(x, x, l, r, pp))), 8);
    check('crush', await bytesPerBlock((b) => (fill(b), crush.process(x, x, l, r, 4 + (b % 8), 8000 + (b % 7) * 3000))), 8);
    check('autogain', await bytesPerBlock((b) => (fill(b), gain.process(x, x, x, x, l, r, true, 1))), 8);
    check('modsource', await bytesPerBlock((b) => (fill(b), mod.process(b * B, x, x, out))), 8);
  });

  it('the measurement sees a single small allocation per block', async () => {
    const keep: number[][] = [];
    const perBlock = await bytesPerBlock((b) => {
      const a = [b, b + 1];
      if (b % 500 === 0) keep.push(a);
    });
    expect(perBlock).toBeGreaterThan(8);
  });
});
