/**
 * "Click-free" effect switching, measured in the browser. A click is a jump
 * between neighbouring samples that the steady signal never makes; with a
 * 220 Hz sine in, no sample-to-sample step around a switch may be much larger
 * than the steady signal's largest step (a hard switch is 10× or more).
 *
 *  - switching any effect off and on again (offline render, so the switch
 *    lands at an exact time) crossfades dry and wet
 *  - adding, removing and reordering effects during realtime playback rewires
 *    the chain under a short duck
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
}

test('switching every effect off and on again is click-free', async ({ page }) => {
  await boot(page);
  const rows: { type: string; off: number; on: number }[] = await page.evaluate(async () => {
    const { createEffectUnit } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const specs = await load('/src/audio/effects/specs.ts');
    const urls = await Promise.all(['phaser', 'room', 'satgain', 'crush', 'limiter'].map(async (n) => (await load(`/src/audio/worklets/${n}.worklet.ts?worker&url`)).default as string));
    const SR = 48000;
    const step = (x: Float32Array, a: number, b: number) => {
      let m = 0;
      for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
      return m;
    };
    const ratio = (x: Float32Array, at: number) => step(x, at - 0.005, at + 0.08) / Math.max(step(x, at - 0.2, at - 0.01), step(x, at + 0.15, at + 0.4));
    const out: { type: string; off: number; on: number }[] = [];
    for (const type of specs.EFFECT_TYPES as string[]) {
      const ctx = new OfflineAudioContext(2, 2 * SR, SR);
      for (const u of urls) await ctx.audioWorklet.addModule(u);
      const osc = new OscillatorNode(ctx, { frequency: 220 });
      const amp = new GainNode(ctx, { gain: 0.3 });
      const slot = specs.createEffectSlot(type);
      const unit = createEffectUnit(ctx, slot, 120);
      osc.connect(amp).connect(unit.input);
      unit.output.connect(ctx.destination);
      osc.start();
      void ctx.suspend(0.6).then(async () => {
        unit.update({ ...slot, enabled: false }, 120);
        await new Promise((r) => setTimeout(r, 200)); // let the "switched off → no work" cut happen too
        void ctx.resume();
      });
      void ctx.suspend(1.2).then(() => {
        unit.update({ ...slot, enabled: true }, 120);
        void ctx.resume();
      });
      const r = await ctx.startRendering();
      const x = r.getChannelData(0);
      out.push({ type, off: ratio(x, 0.6), on: ratio(x, 1.2) });
      unit.dispose();
    }
    return out;
  });
  test.info().annotations.push({ type: 'switch', description: '\n' + rows.map((r) => `${r.type.padEnd(11)} off ${r.off.toFixed(2)} · on ${r.on.toFixed(2)}`).join('\n') });
  expect(rows.length).toBeGreaterThan(10);
  for (const r of rows) {
    expect(r.off, `${r.type}: switching off`).toBeLessThan(1.5);
    expect(r.on, `${r.type}: switching on`).toBeLessThan(1.5);
  }
});

test('adding, reordering and removing effects during playback is click-free', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const { TrackChannel, createEffectSlot } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createTrack } = await load('/src/project/defaults.ts');
    const ctx = new AudioContext({ sampleRate: 48000 });
    // capture the channel's output sample by sample
    const code = `registerProcessor('cap', class extends AudioWorkletProcessor {
      process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice()); return true; }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const cap = new AudioWorkletNode(ctx, 'cap', { numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks: Float32Array[] = [];
    cap.port.onmessage = (e) => chunks.push(e.data);
    const track = { ...createTrack('audio', 0), volumeDb: 0, pan: 0 };
    const ch = new TrackChannel(ctx, track, cap, true);
    const osc = new OscillatorNode(ctx, { frequency: 220 });
    const amp = new GainNode(ctx, { gain: 0.3 });
    osc.connect(amp).connect(ch.input);
    osc.start();
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    // transparent effects, so only the rewiring itself could be heard
    const util = createEffectSlot('utility');
    const eq = createEffectSlot('peq');
    await wait(500);
    const changes = [[util], [util, eq], [eq, util], [eq], []];
    for (const slots of changes) {
      ch.syncEffects(slots, 120);
      await wait(250);
    }
    await wait(200);
    osc.stop();
    await ctx.close();
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const x = new Float32Array(n);
    let o = 0;
    for (const c of chunks) x.set(c, (o += c.length) - c.length);
    // skip the start-up (the sine starting is itself a step)
    let first = 0;
    while (first < x.length && Math.abs(x[first] as number) < 1e-4) first++;
    const begin = first + 4800;
    let worst = 0;
    for (let i = begin + 1; i < x.length; i++) worst = Math.max(worst, Math.abs((x[i] as number) - (x[i - 1] as number)));
    let steady = 0;
    for (let i = begin + 1; i < begin + 9600; i++) steady = Math.max(steady, Math.abs((x[i] as number) - (x[i - 1] as number)));
    // and how many dips (the ~12 ms ducks) the capture shows: one per rewire
    let dips = 0;
    let inDip = false;
    for (let i = begin; i + 240 < x.length; i += 60) {
      let p = 0;
      for (let k = i; k < i + 240; k++) p = Math.max(p, Math.abs(x[k] as number));
      const d = p < 0.15;
      if (d && !inDip) dips++;
      inDip = d;
    }
    return { seconds: n / 48000, steady, worst, dips };
  });
  test.info().annotations.push({ type: 'rewire', description: JSON.stringify(r) });
  expect(r.seconds).toBeGreaterThan(1.5);
  expect(r.dips).toBe(5);
  // the 2 ms duck's own fade adds up to A/(τ·SR) ≈ 0.36 × the sine's largest step (measured
  // worst: 1.42–1.49×); a hard rewire without the duck would be a jump of 10× or more
  expect(r.worst / r.steady).toBeLessThan(2);
});
