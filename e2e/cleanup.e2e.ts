/**
 * Resource cleanup: adding tracks (every instrument, with effects and a
 * sidechain), playing them and deleting them again, many times over, must
 * leave the engine where it started:
 *
 *  - the engine's track channels go back to the baseline
 *  - the live Web Audio node count (Chrome DevTools' WebAudio domain reports
 *    every node created and destroyed) returns to the baseline after GC
 *  - the JS heap after forced GC doesn't trend upwards
 *
 * Undo history is excluded: the churn is committed with skipHistory, because
 * undo deliberately keeps old projects (bounded by the history limit).
 */
import { expect, test } from '@playwright/test';

test('track churn (add with effects → play → delete, ×15) leaks no channels, audio nodes or heap', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
  const cdp = await page.context().newCDPSession(page);
  let live = 0;
  let peak = 0;
  cdp.on('WebAudio.audioNodeCreated', () => (peak = Math.max(peak, ++live)));
  cdp.on('WebAudio.audioNodeWillBeDestroyed', () => live--);
  await cdp.send('WebAudio.enable');
  await cdp.send('HeapProfiler.enable');

  const settle = async () => {
    // GC a few times: node destruction follows the JS wrappers' collection
    for (let i = 0; i < 4; i++) {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(150);
    }
    const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const channels = await page.evaluate(() => ((window as unknown as { __phasr: Record<string, any> }).__phasr.engine as any).channels.size as number);
    return { heap, channels, nodes: live };
  };

  const cycle = () =>
    page.evaluate(async () => {
      const { projectStore, engine, createEffectSlot } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
      const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
      const { createTrack, createMidiClip } = await load('/src/project/defaults.ts');
      const defs = await load('/src/instruments/definitions.ts');
      const { createRoute } = await load('/src/project/modulation.ts');
      const types = defs.INSTRUMENT_TYPES as string[];
      const added = types.map((type, i) => {
        const t = createTrack('instrument', 10 + i, defs.INSTRUMENTS[type].createConfig());
        t.effects = ['saturator', 'reverb', 'room', 'phaser', 'compressor'].map((x) => createEffectSlot(x));
        return t;
      });
      const route = createRoute(added[1], added[0].id, 'audio', { kind: 'track', param: 'volumeDb' });
      if (route) added[1].modulations = [route];
      const clips = Object.fromEntries(
        added.map((t: any) => {
          const c = createMidiClip(t.id, 0, 3840);
          c.notes = [0, 1, 2, 3].map((b) => ({ id: `${t.id}-${b}`, pitch: 48 + b * 4, start: b * 480, length: 400, velocity: 100 }));
          return [c.id, c];
        }),
      );
      const commit = (label: string, f: (p: any) => any) => projectStore.getState().commit(label, f, { skipHistory: true });
      commit('churn add', (p: any) => ({ ...p, tracks: [...p.tracks, ...added], clips: { ...p.clips, ...clips } }));
      engine.transport.play({ fromTick: 0 });
      await new Promise((r) => setTimeout(r, 250));
      engine.transport.stop();
      const ids = new Set(added.map((t: any) => t.id));
      commit('churn remove', (p: any) => ({
        ...p,
        tracks: p.tracks.filter((t: any) => !ids.has(t.id)),
        clips: Object.fromEntries(Object.entries(p.clips).filter(([, c]: any) => !ids.has(c.trackId))),
      }));
      await new Promise((r) => setTimeout(r, 50));
      return added.length;
    });

  // warm-up: first use compiles worklets, caches impulse responses etc.
  await cycle();
  await cycle();
  const base = await settle();
  const samples = [base];
  const CYCLES = Number(process.env.CLEANUP_CYCLES ?? 15);
  for (let i = 0; i < CYCLES; i++) {
    expect(await cycle()).toBeGreaterThan(3);
    if (i % 5 === 4) samples.push(await settle());
  }
  const end = samples.at(-1)!;
  test.info().annotations.push({ type: 'cleanup', description: samples.map((s) => `channels ${s.channels} · live nodes ${s.nodes} · heap ${(s.heap / 1e6).toFixed(2)} MB`).join('\n') + `\npeak live nodes ${peak}` });
  expect(end.channels).toBe(base.channels);
  // the node counter really saw the churn (each cycle builds hundreds of nodes)
  expect(peak).toBeGreaterThan(100);
  // every node the churn created was destroyed (a little slack for nodes still waiting on GC)
  expect(end.nodes - base.nodes).toBeLessThan(20);
  // heap: no growth trend (15 cycles × 5 instruments × 5 effects; a leak of even one
  // effect per cycle would show as megabytes). What does grow slowly is not the app's:
  // a heap-snapshot diff over 30 more cycles (+0.5 MB) was ~95% V8 JIT code and the
  // browser's buffered performance-timeline entries, and 476 bytes of app objects.
  expect(end.heap - base.heap).toBeLessThan(3e6);
});
