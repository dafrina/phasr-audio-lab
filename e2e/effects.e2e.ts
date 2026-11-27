/**
 * Every effect type, with every factory preset, through the real effect
 * units in an OfflineAudioContext (the same code playback and export use):
 *
 *  - output is finite, has no large DC offset and no runaway gain
 *  - the effect falls silent within its declared tail (effectTailSeconds)
 *  - switched off (bypass), the output is the input, sample for sample
 *  - effects that should change the sound do (a broken unit that passes the
 *    input through untouched is caught)
 *
 * Plus behaviour checks that need the real engine: a MIDI sidechain ducks
 * the target at the trigger, removing the route removes the duck, and
 * effect automation reaches the effect during an export.
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
}

interface Result {
  type: string;
  preset: string;
  finite: boolean;
  gainDb: number;
  dc: number;
  tailDb: number;
  changedDb: number;
  bypassMaxDiff: number;
  seconds: number;
}

test('every effect preset: finite, sane gain, no DC, falls silent, exact bypass', async ({ page }) => {
  await boot(page);
  const results: Result[] = await page.evaluate(async () => {
    const w = window as unknown as { __phasr: Record<string, any> };
    // app modules by URL, served by the dev server (not resolvable for tsc)
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createEffectUnit } = w.__phasr;
    const specs = await load('/src/audio/effects/specs.ts');
    const urls = await Promise.all(['phaser', 'room', 'satgain', 'crush'].map(async (n) => (await import(/* @vite-ignore */ `/src/audio/worklets/${n}.worklet.ts?worker&url`)).default as string));
    const SR = 48000;
    const BURST = 0.6;
    // input: 0.6 s of noise + a 220 Hz tone at about −12 dBFS, then silence for the tail
    const signal = (i: number, ch: number) => {
      if (i >= BURST * SR) return 0;
      let s = (i * 2654435761 + ch * 97) >>> 0;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return 0.12 * (((s >>> 0) / 4294967296) * 2 - 1) + 0.15 * Math.sin((2 * Math.PI * 220 * i) / SR);
    };
    const render = async (slot: unknown, seconds: number) => {
      const n = Math.ceil(seconds * SR);
      const ctx = new OfflineAudioContext(2, n, SR);
      for (const u of urls) await ctx.audioWorklet.addModule(u);
      const buf = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 2 });
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) d[i] = signal(i, ch);
      }
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      const unit = createEffectUnit(ctx, slot, 120);
      src.connect(unit.input);
      unit.output.connect(ctx.destination);
      src.start();
      const r = await ctx.startRendering();
      unit.dispose();
      return [r.getChannelData(0), r.getChannelData(1)] as Float32Array[];
    };
    const rms = (c: Float32Array[], a: number, b: number) => {
      let e = 0;
      let k = 0;
      for (const x of c) for (let i = Math.max(0, a); i < Math.min(x.length, b); i++, k++) e += (x[i] as number) ** 2;
      return Math.sqrt(e / Math.max(1, k));
    };
    const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -200);
    const inRms = rms([new Float32Array(BURST * SR).map((_, i) => signal(i, 0)), new Float32Array(BURST * SR).map((_, i) => signal(i, 1))], 0, BURST * SR);
    const out: Result[] = [];
    for (const type of specs.EFFECT_TYPES) {
      const presets = specs.FACTORY_EFFECT_PRESETS.filter((p: { type: string }) => p.type === type);
      for (const p of presets.length ? presets : [{ name: 'default', params: specs.createEffectSlot(type).params }]) {
        const slot = { ...specs.createEffectSlot(type), params: structuredClone(p.params) };
        const tail = specs.effectTailSeconds(slot, 120);
        const seconds = BURST + tail + 0.4;
        const [l, r] = await render(slot, seconds);
        let finite = true;
        let sum = 0;
        let peak = 0;
        for (const x of [l!, r!]) for (let i = 0; i < x.length; i++) {
          const v = x[i] as number;
          if (!Number.isFinite(v)) finite = false;
          sum += v;
          peak = Math.max(peak, Math.abs(v));
        }
        const outRms = rms([l!, r!], 0, BURST * SR);
        // what's left in the last 100 ms (after the declared tail)
        const end = l!.length;
        const tailRms = rms([l!, r!], end - 0.1 * SR, end);
        // how much the effect changed the burst (difference to the dry input)
        let de = 0;
        for (let i = 0; i < BURST * SR; i++) de += ((l![i] as number) - signal(i, 0)) ** 2;
        const changed = Math.sqrt(de / (BURST * SR));
        // bypass: exactly the input
        const off = { ...slot, enabled: false };
        const [bl] = await render(off, BURST + 0.1);
        let bypassMaxDiff = 0;
        for (let i = 0; i < bl!.length; i++) bypassMaxDiff = Math.max(bypassMaxDiff, Math.abs((bl![i] as number) - Math.fround(signal(i, 0))));
        out.push({ type, preset: p.name, finite, gainDb: db(outRms) - db(inRms), dc: sum / (2 * l!.length), tailDb: db(tailRms) - db(inRms), changedDb: db(changed) - db(inRms), bypassMaxDiff, seconds });
      }
    }
    return out;
  });
  const report = results.map((r) => `${r.type.padEnd(10)} ${r.preset.padEnd(20)} gain ${r.gainDb.toFixed(1).padStart(6)} dB · tail ${r.tailDb.toFixed(0).padStart(4)} dB · change ${r.changedDb.toFixed(0).padStart(4)} dB · dc ${r.dc.toExponential(1)} · bypass Δ ${r.bypassMaxDiff.toExponential(1)}`);
  test.info().annotations.push({ type: 'effects', description: '\n' + report.join('\n') });
  expect(results.length).toBeGreaterThan(40);
  for (const r of results) {
    const id = `${r.type} / ${r.preset}`;
    expect(r.finite, `${id}: non-finite samples`).toBe(true);
    // no runaway gain: a saturator's output knob or a parallel compressor may add level, not +20 dB
    expect(r.gainDb, `${id}: gain`).toBeLessThan(15);
    expect(Math.abs(r.dc), `${id}: DC offset`).toBeLessThan(2e-3);
    // silent (−60 dB below the input or quieter) once the declared tail is over
    expect(r.tailDb, `${id}: still sounding after its declared tail`).toBeLessThan(-60);
    // switched off = untouched: bit-identical to the (float32) input
    expect(r.bypassMaxDiff, `${id}: bypass is not transparent`).toBe(0);
  }
  // every preset must change the sound, except the neutral starting points
  for (const r of results.filter((x) => !['Flat', 'Unity', 'Clean (empty)'].includes(x.preset))) {
    expect(r.changedDb, `${r.type} / ${r.preset}: no audible effect`).toBeGreaterThan(-40);
  }
});

test('a MIDI sidechain ducks its target on the trigger; removing the route removes the duck', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __phasr: Record<string, any> };
    // app modules by URL, served by the dev server (not resolvable for tsc)
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { projectStore, renderProjectToWav, engine } = w.__phasr;
    const { createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const { createRoute } = await load('/src/project/modulation.ts');
    const base = projectStore.getState().project;
    const kick = createTrack('instrument', 0, defs.INSTRUMENTS.drumrack.createConfig());
    kick.id = 'k';
    kick.mute = false;
    const pad = createTrack('instrument', 1, defs.INSTRUMENTS.triosc.createConfig());
    pad.id = 'p';
    const kc = createMidiClip('k', 0, 7680);
    kc.id = 'kc';
    kc.notes = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ id: `k${b}`, pitch: 36, start: b * 960, length: 100, velocity: 120 }));
    const pc = createMidiClip('p', 0, 7680);
    pc.id = 'pc';
    pc.notes = [{ id: 'p0', pitch: 57, start: 0, length: 7680, velocity: 100 }];
    const route = createRoute(pad, 'k', 'midi', { kind: 'track', param: 'volumeDb' });
    const make = (withRoute: boolean, mutePad: boolean) => ({
      ...base,
      bpm: 120,
      loop: { ...base.loop, enabled: false },
      tracks: [{ ...kick, mute: true }, { ...pad, mute: mutePad, modulations: withRoute && route ? [{ ...route, note: 36, depth: -24, attack: 0.001, hold: 0.05, release: 0.15 }] : [] }],
      clips: { kc, pc },
      master: { ...base.master, effects: [] },
    });
    const level = async (p: unknown) => {
      const out = await renderProjectToWav(p, engine.assets, { sampleRate: 48000, range: 'song', tail: false, format: 'pcm16' });
      const L = out.audio.left as Float32Array;
      // level 30 ms after each beat (ducked) and 400 ms after it (recovered), beats 1–7
      const at = (sec: number) => {
        let e = 0;
        const a = Math.round(sec * 48000);
        for (let i = a; i < a + 960; i++) e += (L[i] as number) ** 2;
        return 10 * Math.log10(e / 960 + 1e-20);
      };
      let duck = 0;
      let open = 0;
      for (let b = 1; b < 8; b++) {
        duck += at(b * 0.5 + 0.03);
        open += at(b * 0.5 + 0.4);
      }
      return { duck: duck / 7, open: open / 7 };
    };
    // (the kick track is muted: a muted source still triggers MIDI routes — the trigger is its notes)
    return { routed: await level(make(true, false)), plain: await level(make(false, false)) };
  });
  // with the route: ≥ 12 dB lower right after each kick than 400 ms later
  expect(r.routed.open - r.routed.duck).toBeGreaterThan(12);
  // without: no dip
  expect(Math.abs(r.plain.open - r.plain.duck)).toBeLessThan(1.5);
});

test('effect automation reaches the effect during an export', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __phasr: Record<string, any> };
    // app modules by URL, served by the dev server (not resolvable for tsc)
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { projectStore, renderProjectToWav, engine, createEffectSlot } = w.__phasr;
    const { createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const { FACTORY_PRESETS } = await load('/src/synth/presets.ts');
    const base = projectStore.getState().project;
    const t = createTrack('instrument', 0, { ...defs.INSTRUMENTS.triosc.createConfig(), patch: FACTORY_PRESETS.find((p: { name: string }) => p.name === 'Detuned Saw').patch });
    t.id = 't';
    const util = createEffectSlot('utility');
    util.id = 'u';
    t.effects = [util];
    // Utility gain: 0 dB for the first second, −24 dB for the second
    t.automation = [{ id: 'a', enabled: true, target: { kind: 'fx', slotId: 'u', param: 'gain' }, points: [{ id: '1', tick: 0, value: 0 }, { id: '2', tick: 1920, value: 0 }, { id: '3', tick: 1920, value: -24 }] }];
    const c = createMidiClip('t', 0, 3840);
    c.id = 'c';
    c.notes = [{ id: 'n', pitch: 57, start: 0, length: 3840, velocity: 100 }];
    const out = await renderProjectToWav({ ...base, bpm: 120, tracks: [t], clips: { c }, master: { ...base.master, effects: [] } }, engine.assets, { sampleRate: 48000, range: 'song', tail: false, format: 'pcm16' });
    const L = out.audio.left as Float32Array;
    const seg = (a: number, b: number) => {
      let e = 0;
      for (let i = a * 48000; i < b * 48000; i++) e += (L[i] as number) ** 2;
      return 10 * Math.log10(e / ((b - a) * 48000));
    };
    return { before: seg(0.5, 0.95), after: seg(1.05, 1.9) };
  });
  expect(r.before - r.after).toBeGreaterThan(20);
  expect(r.before - r.after).toBeLessThan(28);
});
