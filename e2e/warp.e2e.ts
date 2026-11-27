/**
 * Time-stretch (warp) in the real browser: a warped clip follows tempo
 * changes (fills its bars, keeps its pitch, plays all of its audio), live
 * playback matches the export, and the long-press stretch gesture on a clip
 * edge — driven with the real mouse — stretches, while a quick drag still
 * trims. Source audio: 1.75 s of A4 (440 Hz) then a 0.25 s A5 (880 Hz)
 * marker = one bar at 120 BPM.
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
const PPQ = 960;

async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

/** an audio track with the A4 / A5 clip at bar 1; `warp`: played at 120 BPM and following the tempo */
async function setup(page: Page, o: { bpm: number; warp: boolean }): Promise<string> {
  return page.evaluate(async ({ bpm, warp }) => {
    const { projectStore, engine, uiStore } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createProject, createTrack, createAudioClip } = await load('/src/project/defaults.ts');
    const { encodeWav } = await load('/src/audio/wav.ts');
    const SR = 48000;
    const n = 2 * SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const fade = Math.min(1, t / 0.005, (2 - t) / 0.005);
      const marker = t >= 1.75;
      x[i] = 0.4 * fade * Math.sin(2 * Math.PI * (marker ? 880 : 440) * t);
    }
    if (!engine.assets.has('warp-src')) await engine.assets.decodeBytes(engine.ctx, encodeWav([x], SR, { format: 'float32' }), 'a4-a5', 'audio/wav', 'warp-src');
    const p = createProject('Warp test');
    p.bpm = bpm;
    p.metronome = false;
    p.master = { ...p.master, limiter: false };
    const t = createTrack('audio', 0);
    t.name = 'Loop';
    t.volumeDb = 0;
    const c = createAudioClip(t.id, 'warp-src', 'A4-A5', 0, 4 * 960, warp ? 120 : undefined);
    c.fadeIn = 0.002;
    c.fadeOut = 0.002;
    const ref = engine.assets.get('warp-src').ref;
    projectStore.getState().loadProject({ ...p, tracks: [t], clips: { [c.id]: c }, assets: { 'warp-src': ref } });
    uiStore.getState().set({ pxPerBeat: 40, scrollX: 0, selectedClipIds: [] });
    return c.id as string;
  }, o);
}

/** set the tempo the way the toolbar does (one project change) */
const setBpm = (page: Page, bpm: number) => page.evaluate((v) => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().commit('Tempo', (p: any) => ({ ...p, bpm: v })), bpm);

/** export one bar (song range, no tail) and analyse it: where A4 / A5 are, their pitch, and the level at the very end */
async function exportBar(page: Page): Promise<{ seconds: number; a4: number; a5: number; markerFrom: number; endRmsDb: number; samples?: number[] }> {
  return page.evaluate(async () => {
    const { projectStore, engine, renderProjectToWav } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { FFT } = await load('/src/audio/stretch/fft.ts');
    const p = projectStore.getState().project;
    const r = await renderProjectToWav(p, engine.assets, { sampleRate: 48000, range: 'song', tail: false, format: 'float32' });
    const x: Float32Array = r.audio.left;
    const SR = 48000;
    const peak = (from: number, to: number) => {
      const N = 16384;
      const fft = new FFT(N);
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      const len = Math.min(N, to - from);
      for (let n = 0; n < len; n++) re[n] = (x[from + n] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / len));
      fft.transform(re, im);
      const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
      let best = 1;
      for (let k = 1; k < N / 2; k++) if (mag(k) > mag(best)) best = k;
      const a = Math.log(mag(best - 1));
      const b = Math.log(mag(best));
      const c = Math.log(mag(best + 1));
      return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / N;
    };
    // where the A5 marker starts: the first 10 ms window dominated by 880 Hz (zero-crossing rate)
    let markerFrom = -1;
    for (let s = 0; s + 480 < x.length; s += 240) {
      let zc = 0;
      let e = 0;
      for (let i = s + 1; i < s + 480; i++) {
        if ((x[i - 1]! < 0) !== (x[i]! < 0)) zc++;
        e += x[i]! * x[i]!;
      }
      if (e / 480 > 1e-4 && zc > 13) {
        markerFrom = s / SR;
        break;
      }
    }
    let e = 0;
    const tailN = Math.round(0.03 * SR);
    for (let i = x.length - tailN - Math.round(0.006 * SR); i < x.length - Math.round(0.006 * SR); i++) e += x[i]! * x[i]!;
    const a4 = peak(Math.round(0.2 * SR), Math.round(0.2 * SR) + 16384);
    const mStart = Math.round((markerFrom + 0.02) * SR);
    const a5 = markerFrom > 0 ? peak(mStart, Math.min(x.length - 300, mStart + 16384)) : 0;
    return { seconds: x.length / SR, a4, a5, markerFrom, endRmsDb: 10 * Math.log10(e / tailN) };
  });
}

test('a warped clip follows the tempo: it fills its bar, keeps its pitch and plays all of its audio', async ({ page }) => {
  await openApp(page);
  await setup(page, { bpm: 120, warp: true });
  const rows: Record<string, unknown>[] = [];
  for (const bpm of [96, 150, 120]) {
    await setBpm(page, bpm);
    const r = await exportBar(page);
    rows.push({ bpm, ...r });
    const bar = (4 * 60) / bpm;
    expect(r.seconds, `${bpm} BPM: one bar`).toBeCloseTo(bar, 2);
    // pitch kept (< 2 cents)
    expect(Math.abs(r.a4 / 440 - 1), `${bpm} BPM: A4 at ${r.a4.toFixed(2)} Hz`).toBeLessThan(0.0012);
    expect(Math.abs(r.a5 / 880 - 1), `${bpm} BPM: A5 at ${r.a5.toFixed(2)} Hz`).toBeLessThan(0.0012);
    // all of the audio, stretched to the bar: the marker starts at 7/8 of it, and the bar's end still sounds
    expect(Math.abs(r.markerFrom - (bar * 7) / 8), `${bpm} BPM: marker at ${r.markerFrom.toFixed(3)} s`).toBeLessThan(0.02);
    expect(r.endRmsDb, `${bpm} BPM: level at the end of the bar`).toBeGreaterThan(-15);
  }
  test.info().annotations.push({ type: 'warp', description: JSON.stringify(rows) });

  // the same clip without warp at 96 BPM: the audio ends early (silence), the pitch is the same
  await setup(page, { bpm: 96, warp: false });
  const off = await exportBar(page);
  expect(off.endRmsDb).toBeLessThan(-80);
  expect(Math.abs(off.markerFrom - 1.75)).toBeLessThan(0.02);
});

test('live playback plays what the export renders', async ({ page }) => {
  await openApp(page);
  await setup(page, { bpm: 96, warp: true });
  const r = await page.evaluate(async () => {
    const { projectStore, engine, renderProjectToWav } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { stretchCache } = await load('/src/audio/stretch/cache.ts');
    const ctx: AudioContext = engine.ctx;
    // wait for the stretched copy (rendered in the worker)
    for (let i = 0; i < 100 && !stretchCache.get('warp-src', 1.25); i++) await new Promise((res) => setTimeout(res, 50));
    const ready = !!stretchCache.get('warp-src', 1.25);
    // record the master output while the transport plays the bar
    const code = `registerProcessor('cap', class extends AudioWorkletProcessor {
      process(i) { const c = i[0] && i[0][0]; if (c) this.port.postMessage(c.slice()); return true; }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const cap = new AudioWorkletNode(ctx, 'cap', { numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const blocks: Float32Array[] = [];
    cap.port.onmessage = (e) => blocks.push(e.data);
    engine.addAnalyser('__master__', cap);
    engine.transport.play({ fromTick: 0 });
    await new Promise((res) => setTimeout(res, 3200));
    engine.transport.stop();
    engine.removeAnalyser('__master__', cap);
    const live = new Float32Array(blocks.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const b of blocks) {
      live.set(b, o);
      o += b.length;
    }
    const out = await renderProjectToWav(projectStore.getState().project, engine.assets, { sampleRate: ctx.sampleRate, range: 'song', tail: false, format: 'float32' });
    const ex: Float32Array = out.audio.left;
    // line the two up (the live recording starts before the transport does), then compare
    const seg = ex.subarray(Math.round(0.3 * ctx.sampleRate), Math.round(2.2 * ctx.sampleRate));
    const off = Math.round(0.3 * ctx.sampleRate);
    const score = (lag: number, step: number) => {
      let s = 0;
      for (let i = 0; i < seg.length; i += step) s += seg[i]! * live[lag + off + i]!;
      return s;
    };
    // coarse (every 16th lag), then exact around the best
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = 0; lag + seg.length + off < live.length; lag += 16) {
      const s = score(lag, 16);
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    const coarse = bestLag;
    best = -Infinity;
    for (let lag = Math.max(0, coarse - 24); lag <= coarse + 24 && lag + seg.length + off < live.length; lag++) {
      const s = score(lag, 1);
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    let ee = 0;
    let ll = 0;
    let xy = 0;
    for (let i = 0; i < seg.length; i++) {
      const a = seg[i]!;
      const b = live[bestLag + off + i]!;
      ee += a * a;
      ll += b * b;
      xy += a * b;
    }
    return { ready, corr: xy / Math.sqrt(ee * ll), levelDb: 10 * Math.log10(ll / ee), sr: ctx.sampleRate };
  });
  test.info().annotations.push({ type: 'live vs export', description: JSON.stringify(r) });
  expect(r.ready).toBe(true);
  expect(r.corr).toBeGreaterThan(0.995);
  expect(Math.abs(r.levelDb)).toBeLessThan(0.1);
});

/** the clip lane canvas and where beat `beats` of track 1 is on screen */
async function laneX(page: Page, beats: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('lanes').boundingBox())!;
  return { x: box.x + beats * 40, y: box.y + 78 / 2 + 8 };
}

const clipOf = (page: Page, id: string) => page.evaluate((cid) => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project.clips[cid], id);

test('long-press on the end edge stretches (pitch kept, one undo step); a quick drag still trims', async ({ page }) => {
  await openApp(page);
  const id = await setup(page, { bpm: 120, warp: false });
  // hold the end edge (4 beats) still for longer than the hold time, then drag it to 8 beats
  const edge = await laneX(page, 4);
  await page.mouse.move(edge.x - 2, edge.y);
  await page.mouse.down();
  // not yet at 300 ms (the hold time is 400 ms); by 500 ms stretch mode shows
  await page.waitForTimeout(300);
  await expect(page.getByTestId('stretch-edge')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await page.getByTestId('stretch-edge').count(), 'stretch mode 500 ms into the press').toBe(1);
  for (let b = 4.25; b <= 8; b += 0.25) await page.mouse.move((await laneX(page, b)).x - 2, edge.y);
  await expect(page.getByTestId('stretch-readout')).toHaveText(/Stretch ×0\.50 · 240\.0 BPM/);
  await page.mouse.up();
  await expect(page.getByTestId('stretch-readout')).toHaveCount(0);
  const c = await clipOf(page, id);
  expect([c.start, c.length, c.warp, c.bpm]).toEqual([0, 8 * PPQ, true, 240]);
  // the audio fills the two bars at half speed, at the same pitch
  const r = await exportBar(page);
  expect(r.seconds).toBeCloseTo(4, 2);
  expect(Math.abs(r.a4 / 440 - 1), `A4 at ${r.a4.toFixed(2)} Hz`).toBeLessThan(0.0012);
  expect(Math.abs(r.markerFrom - 3.5)).toBeLessThan(0.03);
  // one undo step back to the original
  await page.keyboard.press('Control+z');
  const u = await clipOf(page, id);
  expect([u.length, u.warp]).toEqual([4 * PPQ, false]);

  // a short press (150 ms, as a hand does) then a drag trims: shorter, nothing stretched
  const e2 = await laneX(page, 4);
  await page.mouse.move(e2.x - 2, e2.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  for (let b = 3.75; b >= 2; b -= 0.25) await page.mouse.move((await laneX(page, b)).x - 2, e2.y);
  await page.mouse.up();
  const t = await clipOf(page, id);
  expect([t.length, t.warp, t.bpm]).toEqual([2 * PPQ, false, u.bpm]);
  await expect(page.getByTestId('stretch-readout')).toHaveCount(0);
});

test('the clip editor shows the clip tempo: type it, tap it, halve it; the rate and its quality show', async ({ page }) => {
  await openApp(page);
  const id = await setup(page, { bpm: 120, warp: false });
  await page.evaluate((cid) => (window as unknown as { __phasr: Phasr }).__phasr.uiStore.getState().set({ editorClipId: cid, bottomPanel: 'editor' }), id);
  const bar = page.getByTestId('clip-tempo');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('clip-rate')).toHaveText('at its own speed (no stretch)');
  // typing a tempo sets it and switches warp on
  await page.getByTestId('clip-bpm').fill('100');
  let c = await clipOf(page, id);
  expect([c.warp, c.bpm]).toEqual([true, 100]);
  await expect(page.getByTestId('clip-rate')).toContainText('plays at 1.20× (120 ÷ 100 BPM)');
  // tapping along about every 500 ms: the tempo of the taps (as the page saw them)
  await page.evaluate(() => {
    const w = window as unknown as { __taps: number[] };
    w.__taps = [];
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).textContent === 'Tap') w.__taps.push(performance.now());
    }, true);
  });
  for (let i = 0; i < 5; i++) {
    await bar.getByRole('button', { name: 'Tap' }).click();
    if (i < 4) await page.waitForTimeout(500);
  }
  const taps: number[] = await page.evaluate(() => (window as unknown as { __taps: number[] }).__taps);
  const tapped = 60000 / ((taps[4]! - taps[0]!) / 4);
  expect(tapped).toBeGreaterThan(100);
  expect(tapped).toBeLessThan(125);
  c = await clipOf(page, id);
  expect(Math.abs(c.bpm - tapped), `tapped ${tapped.toFixed(2)} BPM, clip ${c.bpm}`).toBeLessThan(0.5);
  // ÷2 twice: 30 BPM → 4× — the edge of the range, marked as rougher
  await bar.getByRole('button', { name: '÷2' }).click();
  await bar.getByRole('button', { name: '÷2' }).click();
  await expect(page.getByTestId('clip-rate')).toContainText('audibly rougher');
});
