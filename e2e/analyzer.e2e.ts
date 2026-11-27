/**
 * The analysers (spectrum, spectrogram, oscilloscope) in the running app:
 * opened from the mixer with the mouse, they draw a 220 Hz tone where it
 * belongs, the scope stands still (triggered), and nothing is analysed or
 * drawn while the window is hidden, a view is switched off or the window is
 * closed. Plus the Limiter's gain-reduction meter on the master.
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
const phasr = 'window.__phasr';

async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

/** one TriOsc track holding A3 (220 Hz, the Init Sine preset) in a looping clip; returns the track id */
async function toneProject(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { projectStore, uiStore } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createProject, createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const p = createProject('Analyser test');
    const t = createTrack('instrument', 0, defs.INSTRUMENTS.triosc.createConfig());
    t.name = 'Tone';
    const c = createMidiClip(t.id, 0, 3840 * 2);
    c.notes = [{ id: 'a', pitch: 57, start: 0, length: 3840 * 2, velocity: 100 }];
    projectStore.getState().loadProject({ ...p, tracks: [t], clips: { [c.id]: c }, loop: { enabled: true, start: 0, end: 3840 * 2 } });
    uiStore.getState().set({ bottomPanel: 'mixer' });
    return t.id as string;
  });
}

const stats = (page: Page): Promise<{ frames: Record<string, number>; draws: Record<string, number>; analysers: number }> =>
  page.evaluate(() => {
    const p = (window as unknown as { __phasr: Phasr }).__phasr;
    return { frames: { ...p.analyzerStats.frames }, draws: { ...p.analyzerStats.draws }, analysers: p.engine.analyserCount() };
  });

/** what a view's canvas shows: per column the topmost "lit" pixel (spectrum), the brightest row of the last column (spectrogram), the trace's height per column (scope) */
async function readCanvas(page: Page, testId: string): Promise<{ w: number; h: number; topY: number[]; brightRow: number; traceY: number[] }> {
  return page.evaluate((id) => {
    const c = document.querySelector(`[data-testid="${id}"]`) as HTMLCanvasElement;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const { width: w, height: h } = c;
    const d = g.getImageData(0, 0, w, h).data;
    const topY: number[] = [];
    for (let x = 0; x < w; x++) {
      let y = 0;
      // the spectrum line (sky blue)
      while (y < h && !(d[(y * w + x) * 4 + 2]! > 200 && d[(y * w + x) * 4 + 1]! > 150 && d[(y * w + x) * 4]! < 120)) y++;
      topY.push(y);
    }
    let brightRow = -1;
    let best = -1;
    for (let y = 0; y < h; y++) {
      const i = (y * w + (w - 1)) * 4;
      const lum = d[i]! + d[i + 1]! + d[i + 2]!;
      if (lum > best) {
        best = lum;
        brightRow = y;
      }
    }
    // the scope trace (green): the middle of its lit pixels in each column
    const traceY: number[] = [];
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        // (anti-aliased: a thin line's pixels are only partly lit)
        if (d[i + 1]! > 90 && d[i + 1]! > d[i]! + 40) {
          sum += y;
          n++;
        }
      }
      traceY.push(n ? sum / n : NaN);
    }
    return { w, h, topY, brightRow, traceY };
  }, testId);
}

test('analysers: open from the mixer, show a tone where it belongs, a still scope; no analysis while hidden or closed', async ({ page }) => {
  await openApp(page);
  const trackId = await toneProject(page);
  await page.click(`[data-testid="analyzer-open-${trackId}"]`);
  await expect(page.getByTestId('analyzer')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.transport.play({ fromTick: 0 }));
  await page.waitForTimeout(1500);

  // all three views run, each fed by its own analyser
  const s0 = await stats(page);
  expect(s0.analysers).toBe(3);
  for (const v of ['spectrum', 'spectrogram', 'scope']) expect(s0.draws[v], v).toBeGreaterThan(20);

  // 220 Hz on the log axis 20 Hz … 20 kHz
  const at220 = Math.log(220 / 20) / Math.log(1000);
  const spec = await readCanvas(page, 'analyzer-spectrum');
  const peakX = spec.topY.indexOf(Math.min(...spec.topY));
  expect(Math.abs(peakX / spec.w - at220), `spectrum peak at ${(peakX / spec.w).toFixed(3)} of the width`).toBeLessThan(0.02);
  const gram = await readCanvas(page, 'analyzer-spectrogram');
  expect(Math.abs(1 - gram.brightRow / gram.h - at220), `spectrogram's brightest row at ${(1 - gram.brightRow / gram.h).toFixed(3)} of the height`).toBeLessThan(0.03);

  // the scope is triggered: frames 300 ms apart show the waveform in the same place (within the
  // one-sample jitter of the trigger); free-running, it would drift by up to half a period
  const a = await readCanvas(page, 'analyzer-scope');
  const swing = Math.max(...a.traceY.filter(Number.isFinite)) - Math.min(...a.traceY.filter(Number.isFinite));
  expect(swing, 'the trace fills the view (auto range)').toBeGreaterThan(a.h * 0.6);
  for (let k = 0; k < 3; k++) {
    await page.waitForTimeout(300);
    const b = await readCanvas(page, 'analyzer-scope');
    let sum = 0;
    let n = 0;
    for (let x = 0; x < a.w; x++) {
      if (!Number.isFinite(a.traceY[x]!) || !Number.isFinite(b.traceY[x]!)) continue;
      sum += Math.abs(a.traceY[x]! - b.traceY[x]!);
      n++;
    }
    expect(n).toBeGreaterThan(a.w * 0.9);
    expect(sum / n, `the trace moved ${(sum / n).toFixed(1)} px per column between frames`).toBeLessThan(3);
  }

  // a hidden page: no analysis, no frames
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  const h1 = await stats(page);
  expect(h1.analysers).toBe(0);
  await page.waitForTimeout(500);
  const h2 = await stats(page);
  expect(h2.frames).toEqual(h1.frames);
  // visible again: back on
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  const v1 = await stats(page);
  expect(v1.analysers).toBe(3);
  expect(v1.frames.scope).toBeGreaterThan(h2.frames.scope!);

  // switching a view off stops its analyser; closing the window (Esc) stops all
  await page.getByTestId('analyzer').getByRole('button', { name: 'Spectrogram', exact: true }).click();
  await page.waitForTimeout(100);
  expect((await stats(page)).analysers).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('analyzer')).toHaveCount(0);
  const c1 = await stats(page);
  expect(c1.analysers).toBe(0);
  await page.waitForTimeout(400);
  expect((await stats(page)).frames).toEqual(c1.frames);
  void phasr;
});

test('a Limiter on the master: its gain-reduction meter reads the live worklet, the output stays under the ceiling', async ({ page }) => {
  await openApp(page);
  await toneProject(page);
  const r = await page.evaluate(async () => {
    const { projectStore, engine, createEffectSlot } = (window as unknown as { __phasr: Phasr }).__phasr;
    const slot = createEffectSlot('limiter');
    slot.params = { ...slot.params, drive: 24, ceiling: -12 };
    projectStore.getState().commit('Master limiter', (p: any) => ({ ...p, master: { ...p.master, effects: [slot] } }));
    engine.transport.play({ fromTick: 0 });
    await new Promise((res) => setTimeout(res, 800));
    let peak = 0;
    let gr = 0;
    for (let k = 0; k < 10; k++) {
      await new Promise((res) => setTimeout(res, 50));
      const m = engine.readMasterMeter({ peakL: 0, peakR: 0 });
      peak = Math.max(peak, m.peakL, m.peakR);
      gr = Math.min(gr, engine.compressorReduction('__master__', slot.id));
    }
    engine.transport.stop();
    return { peakDb: 20 * Math.log10(peak), gr };
  });
  test.info().annotations.push({ type: 'limiter', description: `master peak ${r.peakDb.toFixed(2)} dBFS, gain reduction ${r.gr.toFixed(1)} dB` });
  // the tone (about −9 dBFS) driven 24 dB into a −12 dB ceiling: about 21 dB of reduction, nothing above −12 dBFS
  expect(r.gr).toBeLessThan(-15);
  expect(r.peakDb).toBeLessThanOrEqual(-12 + 0.01);
  expect(r.peakDb).toBeGreaterThan(-13);
});
