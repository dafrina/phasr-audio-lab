/**
 * Main-thread cost of the analyser views (README › Performance › App): 8
 * instrument tracks playing with the mixer open, then the master's analyser
 * with each view alone, all three, and all three in a hidden tab. Busy time =
 * Chrome's TaskDuration metric over 5 s of wall-clock time (CDP).
 *
 * A measurement, not a check: it only runs with UI_COST=1
 *   UI_COST=1 npx playwright test e2e/ui-cost.e2e.ts
 * and prints a table (numbers depend on the machine).
 */
import { test } from '@playwright/test';

type Phasr = Record<string, any>;

test('UI cost: analysers', async ({ page }) => {
  test.skip(!process.env.UI_COST, 'a measurement: run with UI_COST=1');
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
  await page.evaluate(async () => {
    const { projectStore, uiStore, engine } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createProject, createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const p = createProject('UI cost');
    const types = ['triosc', 'keys', 'drumrack', 'triosc', 'keys', 'triosc', 'keys', 'drumrack'];
    const tracks = types.map((type, i) => createTrack('instrument', i, defs.INSTRUMENTS[type].createConfig()));
    const clips: Record<string, unknown> = {};
    tracks.forEach((t: any, i: number) => {
      const c = createMidiClip(t.id, 0, 3840);
      c.notes = Array.from({ length: 8 }, (_, k) => ({ id: `${i}-${k}`, pitch: t.instrument.type === 'drumrack' ? 36 + ((k * 3) % 12) : 48 + ((k * 5 + i * 3) % 24), start: k * 480, length: 400, velocity: 90 }));
      clips[c.id] = c;
    });
    projectStore.getState().loadProject({ ...p, tracks, clips, loop: { enabled: true, start: 0, end: 3840 } });
    uiStore.getState().set({ bottomPanel: 'mixer' });
    engine.transport.play({ fromTick: 0 });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const task = async () => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) as number;
  const frames = () => page.evaluate(() => {
    const f = (window as unknown as { __phasr: Phasr }).__phasr.analyzerStats.frames;
    return f.spectrum + f.spectrogram + f.scope;
  });
  const measure = async () => {
    await page.waitForTimeout(1000);
    const t0 = await task();
    const f0 = await frames();
    const w0 = Date.now();
    await page.waitForTimeout(5000);
    const t1 = await task();
    const f1 = await frames();
    const sec = (Date.now() - w0) / 1000;
    return { busy: ((t1 - t0) / sec) * 100, viewFps: (f1 - f0) / sec };
  };
  const setViews = (v: { spectrum: boolean; spectrogram: boolean; scope: boolean }) =>
    page.evaluate(async (want) => {
      for (const [label, on] of [['Spectrum', want.spectrum], ['Spectrogram', want.spectrogram], ['Scope', want.scope]] as const) {
        const b = [...document.querySelectorAll('[data-testid="analyzer"] button')].find((x) => x.textContent === label) as HTMLButtonElement;
        if ((b.getAttribute('aria-pressed') === 'true') !== on) b.click();
      }
    }, v);
  const rows: [string, { busy: number; viewFps: number }][] = [];
  rows.push(['Playing, mixer open', await measure()]);
  await page.click('[data-testid="analyzer-open-__master__"]');
  await page.waitForSelector('[data-testid="analyzer"]');
  await setViews({ spectrum: true, spectrogram: false, scope: false });
  rows.push(['+ analyser: spectrum', await measure()]);
  await setViews({ spectrum: false, spectrogram: true, scope: false });
  rows.push(['+ analyser: spectrogram', await measure()]);
  await setViews({ spectrum: false, spectrogram: false, scope: true });
  rows.push(['+ analyser: scope', await measure()]);
  await setViews({ spectrum: true, spectrogram: true, scope: true });
  rows.push(['+ analyser: all three', await measure()]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  rows.push(['all three, tab hidden', await measure()]);
  const table = rows.map(([k, v]) => `${k.padEnd(26)} ${v.busy.toFixed(1).padStart(5)} %   (view frames/s ${v.viewFps.toFixed(0)})`).join('\n');
  console.log(`\nmain-thread busy time\n${table}`);
});
