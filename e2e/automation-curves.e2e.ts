/**
 * Curved automation segments in the real app:
 *  - editing with the real mouse: bend a segment by its handle (the handle follows the
 *    pointer, a detent at straight, Shift = fine, double-click resets), Alt-drag on the
 *    line, an S-curve's steepness and bend position, the right-click shape menu (on one
 *    segment and on several selected points), each gesture one undo step;
 *  - offline renders (the export path) of every kind of target, measured against the
 *    curve the lane draws: track volume and pan, an effect parameter, an instrument
 *    parameter inside a worklet (TriOsc), drum pad parameters read at each hit, and the
 *    AudioParam path itself (linear and exponential parameters) through a probe, live
 *    lookahead windows against the export's single plan.
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
test.describe.configure({ timeout: 90_000 });

const PPQ = 960;
const TRACK_H = 78;

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

const project = (page: Page): Promise<any> => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project);
const ui = (page: Page): Promise<any> => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __phasr: Phasr }).__phasr.uiStore.getState())));

async function addTrack(page: Page, label: string): Promise<string> {
  const before = (await project(page)).tracks.length;
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click();
  await expect.poll(async () => (await project(page)).tracks.length).toBe(before + 1);
  return (await project(page)).tracks.at(-1).id;
}

test('bend automation with the mouse: handle, detent, Shift, double-click, Alt-drag, S-curve bend, shape menu, undo', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  // a Pan lane (−1…1, linear): Automation mode comes on with the lane shown
  await page.locator('select[title^="Automation lane shown"]').nth(index).selectOption('+pan');
  await expect.poll(async () => (await ui(page)).automationMode).toBe(true);
  const lane = async () => (await project(page)).tracks[index].automation[0];
  const shapeOf = async (i: number) => (await lane()).points[i].shape;

  const cv = page.getByTestId('lanes');
  const box = (await cv.boundingBox())!;
  const { pxPerBeat, scrollX } = await ui(page);
  const top = index * TRACK_H + 17;
  const h = TRACK_H - 23;
  const X = (tick: number) => box.x + (tick / PPQ) * pxPerBeat - scrollX;
  const Y = (v: number) => box.y + top + (1 - (v + 1) / 2) * h;
  // points: bar 2 low, bar 4 high (a rising segment), bar 6 middle
  for (const [tick, v] of [[4 * PPQ, -0.8], [12 * PPQ, 0.8], [20 * PPQ, 0]] as const) await page.mouse.click(X(tick), Y(v));
  await expect.poll(async () => (await lane()).points.length).toBe(4);
  const p = (await lane()).points;
  const [a, b] = [p[1], p[2]];
  const ya = Y(a.value);
  const yb = Y(b.value);
  const xm = (X(a.tick) + X(b.tick)) / 2;
  const ym = (ya + yb) / 2;
  const readout = page.getByTestId('curve-readout');

  // 1) hover the segment: its handle sits mid-segment; drag it down → the curve follows the pointer
  //    (below the line on a rising segment = slow then fast = a positive amount)
  await page.mouse.move(xm - 30, ym + 3);
  await page.mouse.move(xm, ym);
  await page.mouse.down();
  await page.mouse.move(xm, ym + 6);
  await page.mouse.move(xm, ym + 12);
  await expect(readout).toHaveText(/^Curve \+\d+%$/);
  await page.mouse.up();
  await expect(readout).toHaveCount(0);
  const bent = await shapeOf(1);
  expect(bent.type).toBe('curve');
  expect(bent.amount).toBeGreaterThan(0.2);
  // the curve's midpoint is where the handle was dropped: (ym + 12) on screen
  const m = (ym + 12 - ya) / (yb - ya);
  expect(bent.amount).toBeCloseTo((2 * Math.log((1 - m) / m)) / 5, 2);
  // one undo step for the whole drag, and redo
  await page.keyboard.press('Control+z');
  expect(await shapeOf(1)).toBeUndefined();
  await page.keyboard.press('Control+Shift+z');
  expect(await shapeOf(1)).toEqual(bent);

  // 2) double-click the handle: straight again
  const midY = ya + (yb - ya) * (1 / (Math.exp((5 * bent.amount) / 2) + 1));
  await page.mouse.move(xm, midY);
  await page.mouse.dblclick(xm, midY);
  expect(await shapeOf(1)).toBeUndefined();

  // 3) the detent: a nudge of a pixel stays exactly straight
  await page.mouse.move(xm, ym);
  await page.mouse.down();
  await page.mouse.move(xm, ym + 1);
  await expect(readout).toHaveText('Linear');
  await page.mouse.up();
  expect(await shapeOf(1)).toBeUndefined();

  // 4) Shift = fine: the same drag bends far less
  await page.mouse.move(xm, ym);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(xm, ym + 6);
  await page.mouse.move(xm, ym + 12);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const fine = await shapeOf(1);
  expect(fine.amount).toBeGreaterThan(0);
  expect(fine.amount).toBeLessThan(bent.amount / 3);
  await page.keyboard.press('Control+z');

  // 5) Alt-drag on the line itself (a quarter of the way along, away from the handle): up = above the line
  const xq = X(a.tick) + (X(b.tick) - X(a.tick)) / 4;
  const yq = ya + (yb - ya) / 4;
  await page.keyboard.down('Alt');
  await page.mouse.move(xq, yq);
  await page.mouse.down();
  await page.mouse.move(xq, yq - 6);
  await page.mouse.move(xq, yq - 12);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect((await shapeOf(1)).amount).toBeLessThan(-0.2);
  // (Alt-click on a point still deletes it — the existing gesture — and nothing else changed)
  expect((await lane()).points).toHaveLength(4);
  await page.keyboard.press('Control+z');
  expect(await shapeOf(1)).toBeUndefined();

  // 6) the shape menu on the segment: S-curve
  await page.mouse.click(xq, yq + 20, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: 'Linear' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'S-curve' }).click();
  expect(await shapeOf(1)).toEqual({ type: 's', steepness: 0.5, bend: 0.5 });
  // drag its handle (at the bend, on the straight line) up and to the right: steeper, bend later
  const w = X(b.tick) - X(a.tick);
  await page.mouse.move(xm, ym);
  await page.mouse.down();
  await page.mouse.move(xm + w * 0.1, ym - 6);
  await page.mouse.move(xm + w * 0.25, ym - 12);
  await expect(readout).toHaveText(/^S \d+% · bend at (74|75|76)%$/);
  await page.mouse.up();
  const s = await shapeOf(1);
  expect(s.type).toBe('s');
  expect(s.steepness).toBeCloseTo(0.5 + 12 / 60, 2);
  expect(s.bend).toBeCloseTo(0.75, 1);
  // the handle followed the bend: grab it there and pull down to an inverse S
  const xb2 = X(a.tick) + s.bend * w;
  const yb2 = ya + (yb - ya) * s.bend;
  await page.mouse.move(xb2 - 20, yb2);
  await page.mouse.move(xb2, yb2);
  await page.mouse.down();
  await page.mouse.move(xb2, yb2 + 30);
  await page.mouse.move(xb2, yb2 + 60);
  await page.mouse.up();
  const inv = await shapeOf(1);
  expect(inv.steepness).toBeLessThan(-0.2);
  expect(inv.bend).toBeCloseTo(s.bend, 6);

  // 7) Hold, then several selected points: Ctrl-click the first and last → one menu shapes both segments
  await page.mouse.click(xq, yq + 20, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Hold' }).click();
  expect(await shapeOf(1)).toEqual({ type: 'hold' });
  const c = (await lane()).points[3];
  await page.mouse.click(X(a.tick), Y(a.value));
  await page.keyboard.down('Control');
  await page.mouse.click(X(c.tick), Y(c.value));
  await page.keyboard.up('Control');
  // (a plain click selected the first point alone; Ctrl-click added the last)
  expect((await project(page)).tracks[index].automation[0].points.map((q: any) => q.tick)).toEqual(p.map((q: any) => q.tick));
  await page.mouse.click(X(b.tick) + 40, Y(0.3), { button: 'right' });
  await expect(page.getByRole('menu').getByText('Shape of 2 segments')).toBeVisible();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Curve', exact: true }).click();
  expect([await shapeOf(1), await shapeOf(2), await shapeOf(3)]).toEqual([{ type: 'curve', amount: 0.5 }, { type: 'curve', amount: 0.5 }, undefined]);
  // undo walks back one gesture at a time: the two-segment curve, the hold, the inverse S, the S drag, the S
  for (const want of [{ type: 'hold' }, inv, s, { type: 's', steepness: 0.5, bend: 0.5 }, undefined]) {
    await page.keyboard.press('Control+z');
    expect(await shapeOf(1)).toEqual(want);
  }
  // right-click on a point: its segment's shape, plus Delete
  await page.mouse.click(X(b.tick), Y(b.value), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /Delete point/ }).click();
  expect((await lane()).points).toHaveLength(3);
  expect((await project(page)).tracks[index].id).toBe(trackId);
});

test('copy / cut / paste / duplicate automation points with the mouse and keyboard; values map into another lane; one undo each', async ({ page }) => {
  await openApp(page);
  await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  const sel = page.locator('select[title^="Automation lane shown"]').nth(index);
  await sel.selectOption('+pan');
  await expect.poll(async () => (await ui(page)).automationMode).toBe(true);
  const lanes = async () => (await project(page)).tracks[index].automation;
  const pan = async () => (await lanes()).find((l: any) => l.target.param === 'pan');
  const view = (l: any) => l.points.map((p: any) => [p.tick, Math.round(p.value * 100) / 100, p.shape?.type ?? '-']);

  const cv = page.getByTestId('lanes');
  const box = (await cv.boundingBox())!;
  const { pxPerBeat, scrollX } = await ui(page);
  const top = index * TRACK_H + 17;
  const h = TRACK_H - 23;
  const X = (tick: number) => box.x + (tick / PPQ) * pxPerBeat - scrollX;
  const Y = (v: number) => box.y + top + (1 - (v + 1) / 2) * h;
  // a little pattern in bar 2: low, high (with a curve into the next point), middle
  for (const [tick, v] of [[4 * PPQ, -0.6], [5 * PPQ, 0.6], [6 * PPQ, 0]] as const) await page.mouse.click(X(tick), Y(v));
  await page.mouse.click(X(5 * PPQ) + 30, Y(-0.3), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Curve', exact: true }).click();
  const before = view(await pan());
  expect(before).toEqual([[0, 0, '-'], [3840, -0.6, '-'], [4800, 0.6, 'curve'], [5760, 0, '-']]);

  // box-select the three (Ctrl-drag on empty lane space), copy, hover bar 4, paste
  await page.keyboard.down('Control');
  await page.mouse.move(X(4 * PPQ) - 12, box.y + top - 4);
  await page.mouse.down();
  await page.mouse.move(X(5 * PPQ), box.y + top + h / 2);
  await page.mouse.move(X(6 * PPQ) + 12, box.y + top + h + 4);
  await page.mouse.up();
  await page.keyboard.press('c');
  await page.keyboard.up('Control');
  await page.mouse.move(X(12 * PPQ), Y(0.9));
  await page.keyboard.press('Control+v');
  expect(view(await pan())).toEqual([...before, [11520, -0.6, '-'], [12480, 0.6, 'curve'], [13440, 0, '-']]);
  // one undo step
  await page.keyboard.press('Control+z');
  expect(view(await pan())).toEqual(before);
  await page.keyboard.press('Control+Shift+z');
  // Ctrl+D: the copies start on the last selected point (the pasted points are selected)
  await page.keyboard.press('Control+d');
  const dup = view(await pan());
  expect(dup.slice(-3)).toEqual([[13440, -0.6, '-'], [14400, 0.6, 'curve'], [15360, 0, '-']]);
  expect(dup).toContainEqual([13440, 0, '-']);
  await page.keyboard.press('Control+z');

  // paste over existing points (a beat earlier): the pasted span (10560–12480) replaces the point inside it
  // (11520); the one on its end edge (12480, another value) stays as a step after the pasted point
  await page.mouse.move(X(11 * PPQ), Y(0.9));
  await page.keyboard.press('Control+v');
  expect(view(await pan())).toEqual([...before, [10560, -0.6, '-'], [11520, 0.6, 'curve'], [12480, 0, '-'], [12480, 0.6, 'curve'], [13440, 0, '-']]);
  await page.keyboard.press('Control+z');
  // (select the pasted points again: Ctrl-drag around them)
  await page.keyboard.down('Control');
  await page.mouse.move(X(12 * PPQ) - 12, box.y + top - 4);
  await page.mouse.down();
  await page.mouse.move(X(14 * PPQ) + 12, box.y + top + h + 4);
  await page.mouse.up();
  await page.keyboard.up('Control');

  // Ctrl+X cuts the selection (one undo); Delete deletes it
  await page.keyboard.press('Control+x');
  expect(view(await pan())).toEqual(before);
  await page.keyboard.press('Control+z');
  expect((await pan()).points).toHaveLength(7);
  await page.keyboard.down('Control');
  await page.mouse.move(X(12 * PPQ) - 12, box.y + top - 4);
  await page.mouse.down();
  await page.mouse.move(X(14 * PPQ) + 12, box.y + top + h + 4);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  expect(view(await pan())).toEqual(before);
  expect((await project(page)).tracks).toHaveLength(index + 1); // (Delete took the points, not the track)

  // into another lane with another range (Pan −1…1 → Volume −60…+6 dB): by normalised position
  await sel.selectOption('+volumeDb');
  await expect.poll(async () => (await lanes()).length).toBe(2);
  const yVol = (db: number) => box.y + top + (1 - (db + 60) / 66) * h;
  await page.mouse.move(X(8 * PPQ), yVol(-30));
  await page.keyboard.press('Control+v');
  const vol = (await lanes()).find((l: any) => l.target.param === 'volumeDb');
  const mapped = (v: number) => -60 + ((v + 1) / 2) * 66;
  expect(vol.points.slice(1).map((p: any) => p.tick)).toEqual([7680, 8640, 9600]);
  vol.points.slice(1).forEach((p: any, i: number) => expect(p.value).toBeCloseTo(mapped([-0.6, 0.6, 0][i]!), 9));
  expect(vol.points[2].shape).toEqual({ type: 'curve', amount: 0.5 });

  // the menu: right-click a selected point → Copy (the selection: the three just pasted); right-click
  // empty lane space → Paste here
  await page.mouse.click(X(8 * PPQ), yVol(mapped(-0.6)), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /^Copy/ }).click();
  await page.mouse.click(X(16 * PPQ), yVol(-30), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /^Paste here/ }).click();
  const after = (await lanes()).find((l: any) => l.target.param === 'volumeDb').points;
  expect(after.slice(-3).map((p: any) => p.tick)).toEqual([15360, 16320, 17280]);
  expect(after.at(-3).value).toBeCloseTo(mapped(-0.6), 9);
  // right-click a point outside the selection (now the three pasted at bar 5): it alone is selected and copied
  await page.mouse.click(X(8 * PPQ), yVol(mapped(-0.6)), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /^Copy/ }).click();
  await page.mouse.click(X(20 * PPQ), yVol(-30), { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /^Paste here/ }).click();
  const one = (await lanes()).find((l: any) => l.target.param === 'volumeDb').points;
  expect(one.length).toBe(after.length + 1);
  expect(one.at(-1).tick).toBe(19200);
});

/** Offline renders of each kind of target, measured against the lane's exact curve. */
test('every kind of automation target plays the curve the lane draws (offline render, measured)', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __phasr: Record<string, any> };
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { projectStore, renderProjectToWav, engine, createEffectSlot } = w.__phasr;
    const { createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const { FACTORY_PRESETS } = await load('/src/synth/presets.ts');
    const auto = await load('/src/project/automation.ts');
    const { dbToGain } = await load('/src/core/ids.ts');
    const { dbToGainFader } = await load('/src/audio/trackChannel.ts');
    const base = projectStore.getState().project;
    const SR = 48000;
    const BPM = 120; // 1920 ticks / s
    const sine = () => ({ ...defs.INSTRUMENTS.triosc.createConfig(), patch: structuredClone(FACTORY_PRESETS.find((p: { name: string }) => p.name === 'Init Sine').patch) });
    // (master safety limiter off: Chrome's DynamicsCompressor delays everything by 6 ms — measure the curve alone)
    const render = async (tracks: any[], clips: Record<string, any>) =>
      (await renderProjectToWav({ ...base, bpm: BPM, tracks, clips, sends: base.sends.map((s: any) => ({ ...s, effects: [] })), master: { ...base.master, effects: [], limiter: false } }, engine.assets, { sampleRate: SR, range: 'song', tail: false, format: 'float32' })).audio;
    /** RMS per 5 ms window from t0 to t1 (s) */
    const rms = (x: Float32Array, t0: number, t1: number) => {
      const out: { t: number; v: number }[] = [];
      const n = Math.round(0.005 * SR);
      for (let i = Math.round(t0 * SR); i + n <= t1 * SR; i += n) {
        let e = 0;
        for (let j = i; j < i + n; j++) e += (x[j] as number) ** 2;
        out.push({ t: (i + n / 2) / SR, v: Math.sqrt(e / n) });
      }
      return out;
    };
    const held = (n: number) => {
      const c = createMidiClip('t', 0, n);
      c.id = 'c';
      // a long note through the whole song (a steady sine)
      c.notes = [{ id: 'n', pitch: 69, start: 0, length: n, velocity: 100 }];
      return { c };
    };
    const results: Record<string, { worst: number; unit: string }> = {};

    // --- track volume: a curve from −40 dB to 0 dB (fast then slow), then an S down to −20 dB
    {
      const t = createTrack('instrument', 0, sine());
      t.id = 't';
      const pts = [
        { id: '1', tick: 1920, value: -40, shape: { type: 'curve', amount: -0.7 } },
        { id: '2', tick: 5760, value: 0, shape: { type: 's', steepness: 0.8, bend: 0.65 } },
        { id: '3', tick: 9600, value: -20 },
      ];
      const ref = await render([{ ...t, automation: [] }], held(11520));
      const out = await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'track', param: 'volumeDb' }, points: pts }] }], held(11520));
      const a = rms(out.left, 1, 5.2);
      const b = rms(ref.left, 1, 5.2);
      let worst = 0;
      a.forEach((s, i) => {
        // (against the reference render at the track's own fader level)
        const want = 20 * Math.log10(dbToGainFader(auto.valueAt(pts, s.t * 1920, { curve: 'linear', min: -60, max: 6 })) / dbToGainFader(t.volumeDb));
        worst = Math.max(worst, Math.abs(20 * Math.log10(s.v / (b[i] as { v: number }).v) - want));
      });
      results.volume = { worst, unit: 'dB' };
    }

    // --- pan: an S from hard left to centre (StereoPanner, stereo input with equal channels)
    {
      const t = createTrack('instrument', 0, sine());
      t.id = 't';
      const pts = [
        { id: '1', tick: 1920, value: -1, shape: { type: 's', steepness: 0.6, bend: 0.3 } },
        { id: '2', tick: 7680, value: 0 },
      ];
      const out = await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'track', param: 'pan' }, points: pts }] }], held(9600));
      const L = rms(out.left, 1.05, 3.95);
      const R = rms(out.right, 1.05, 3.95);
      let worst = 0;
      L.forEach((s, i) => {
        // pan ≤ 0 with equal input channels: R / L = tan((pan + 1)·π/4)
        const pan = (4 / Math.PI) * Math.atan((R[i] as { v: number }).v / s.v) - 1;
        worst = Math.max(worst, Math.abs(pan - auto.valueAt(pts, s.t * 1920, { curve: 'linear', min: -1, max: 1 })));
      });
      results.pan = { worst, unit: 'pan' };
    }

    // --- effect parameter: Utility gain, a curve +6 dB → −30 dB (slow then fast) then a hold
    {
      const t = createTrack('instrument', 0, sine());
      t.id = 't';
      const u = createEffectSlot('utility');
      u.id = 'u';
      t.effects = [u];
      const pts = [
        { id: '1', tick: 1920, value: 6, shape: { type: 'curve', amount: 0.9 } },
        { id: '2', tick: 5760, value: -30, shape: { type: 'hold' } },
        { id: '3', tick: 7680, value: 0 },
      ];
      const ref = await render([{ ...t, automation: [] }], held(9600));
      const out = await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'fx', slotId: 'u', param: 'gain' }, points: pts }] }], held(9600));
      const a = rms(out.left, 1, 4.6);
      const b = rms(ref.left, 1, 4.6);
      let worst = 0;
      a.forEach((s, i) => {
        if (Math.abs(s.t - 4) < 0.01) return; // (the window that straddles the hold's jump)
        const want = 20 * Math.log10(dbToGain(auto.valueAt(pts, s.t * 1920, { curve: 'linear', min: -60, max: 12 })));
        worst = Math.max(worst, Math.abs(20 * Math.log10(s.v / (b[i] as { v: number }).v) - want));
      });
      results.effect = { worst, unit: 'dB' };
    }

    // --- instrument parameter inside the worklet: TriOsc master level, an S 0.1 → 0.9
    //     (the synth smooths its master level with a 10 ms one-pole: the expected curve goes through the same)
    {
      const t = createTrack('instrument', 0, sine());
      t.id = 't';
      const pts = [
        { id: '1', tick: 1920, value: 0.1, shape: { type: 's', steepness: 0.7, bend: 0.4 } },
        { id: '2', tick: 7680, value: 0.9 },
      ];
      const out = await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'inst', param: 'master' }, points: pts }] }], held(9600));
      // against a render at master 1.0 (the same sine phase in every 5 ms window)
      const ref = rms((await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'inst', param: 'master' }, points: [{ id: '1', tick: 0, value: 1 }] }] }], held(9600))).left, 1.05, 4.2);
      let sm = 0.1;
      const k = 1 - Math.exp(-1 / (0.01 * SR));
      const smooth: number[] = [];
      for (let i = 0; i < 5 * SR; i++) {
        sm += (auto.valueAt(pts, (i / SR) * 1920, { curve: 'linear', min: 0, max: 1 }) - sm) * k;
        smooth.push(sm);
      }
      let worst = 0;
      rms(out.left, 1.05, 4.2).forEach((s, i) => (worst = Math.max(worst, Math.abs(s.v / (ref[i] as { v: number }).v - (smooth[Math.round(s.t * SR)] as number)))));
      results.instrument = { worst, unit: 'level 0..1' };
    }

    // --- drum pad gain, read at each hit: a curve 0 dB → −24 dB, a hit every 8th note
    {
      const t = createTrack('instrument', 0, defs.INSTRUMENTS.drumrack.createConfig());
      t.id = 't';
      const c = createMidiClip('t', 0, 9600);
      c.id = 'c';
      c.notes = Array.from({ length: 19 }, (_, i) => ({ id: `n${i}`, pitch: 37, start: 480 * i, length: 120, velocity: 100 }));
      const pts = [
        { id: '1', tick: 960, value: 0, shape: { type: 'curve', amount: 0.8 } },
        { id: '2', tick: 7680, value: -24 },
      ];
      const ref = await render([{ ...t, automation: [] }], { c });
      const out = await render([{ ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'inst', param: 'p1.gain' }, points: pts }] }], { c });
      const peak = (x: Float32Array, t0: number) => {
        let m = 0;
        for (let i = Math.round(t0 * SR); i < Math.round((t0 + 0.2) * SR); i++) m = Math.max(m, Math.abs(x[i] as number));
        return m;
      };
      let worst = 0;
      for (let i = 0; i < 19; i++) {
        const t0 = (480 * i) / 1920;
        const got = 20 * Math.log10(peak(out.left, t0) / peak(ref.left, t0));
        // (the lane's value replaces the pad's own Gain, which the reference render plays at)
        const want = auto.valueAt(pts, 480 * i, { curve: 'linear', min: -36, max: 12 }) - t.instrument.kit.pads[1].gain;
        worst = Math.max(worst, Math.abs(got - want));
      }
      results.drumPad = { worst, unit: 'dB' };
    }
    return results;
  });
  console.log('measured worst deviation from the lane:', JSON.stringify(r));
  // the lane's curve, as rendered: within a fraction of a dB / a percent
  expect(r.volume!.worst).toBeLessThan(0.15);
  expect(r.pan!.worst).toBeLessThan(0.005);
  expect(r.effect!.worst).toBeLessThan(0.12);
  expect(r.instrument!.worst).toBeLessThan(0.008);
  expect(r.drumPad!.worst).toBeLessThan(0.06);
});

test('the AudioParam path: live lookahead windows and the export play the same curve, linear and exponential (probe)', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const sch = await load('/src/audio/scheduling.ts');
    const auto = await load('/src/project/automation.ts');
    const curves = await load('/src/project/curves.ts');
    const { applyParamEvents } = await load('/src/audio/paramEvents.ts');
    const SR = 48000;
    const BPM = 120;
    const specs: Record<string, any> = {
      lin: { label: 'Mix', min: 0, max: 1, default: 0, curve: 'linear', format: String },
      exp: { label: 'Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', format: String },
    };
    const v = (s: any, n: number) => (s.curve === 'exp' ? s.min * Math.pow(s.max / s.min, n) : s.min + (s.max - s.min) * n);
    const out: Record<string, { liveVsExport: number; vsLane: number; events: number }> = {};
    for (const [k, spec] of Object.entries(specs)) {
      const points = [
        { id: 'a', tick: 0, value: v(spec, 0.1), shape: { type: 'curve', amount: 0.9 } },
        { id: 'b', tick: 3000, value: v(spec, 0.9), shape: { type: 's', steepness: 1, bend: 0.7 } },
        { id: 'c', tick: 6500, value: v(spec, 0.2), shape: { type: 'hold' } },
        { id: 'd', tick: 7000, value: v(spec, 0.6), shape: { type: 'curve', amount: -1 } },
        { id: 'e', tick: 9000, value: v(spec, 0.3) },
        { id: 'f', tick: 9600, value: v(spec, 0.5) },
      ];
      const lane = { id: 'L', enabled: true, target: { kind: 'track', param: 'volumeDb' }, points };
      const loop = { enabled: true, start: 1200, end: 8200 };
      const ctxFor = (lp: any) => ({ bpm: BPM, loop: lp, beatTicks: 960, barTicks: 3840, metronome: false, tracks: [{ id: 't', kind: 'audio', automation: [lane] }], clips: [], laneSpec: () => spec });
      const seconds = 7;
      const renderWith = async (events: any[]) => {
        const ctx = new OfflineAudioContext(1, seconds * SR, SR);
        const src = new ConstantSourceNode(ctx, { offset: points[0]!.value });
        src.connect(ctx.destination);
        applyParamEvents({ param: src.offset, map: (x: number) => x, exp: spec.curve === 'exp' }, events);
        src.start(0);
        return (await ctx.startRendering()).getChannelData(0);
      };
      // export: one plan (the loop on, from its start); live: 25 ms steps, 150 ms ahead, events kept in order
      const exp = sch.planWindow(ctxFor(loop), { tick: loop.start, time: 0, fresh: true }, seconds).automation[0].events;
      const live: any[] = [];
      let cursor = { tick: loop.start, time: 0, fresh: true };
      for (let now = 0; now < seconds; now += 0.025) {
        const plan = sch.planWindow(ctxFor(loop), cursor, now + 0.15);
        for (const a of plan.automation) live.push(...sch.inOrder(a.events, live.at(-1)?.time ?? -Infinity).events);
        cursor = plan.next;
      }
      const [E, Lv] = await Promise.all([renderWith(exp), renderWith(live)]);
      let d = 0;
      let lanErr = 0;
      const span = loop.end - loop.start;
      for (let i = 0; i < seconds * SR - 1; i++) {
        d = Math.max(d, Math.abs((E[i] as number) - (Lv[i] as number)) / Math.max(1, Math.abs(E[i] as number)));
        const tick = loop.start + (((i / SR) * 1920) % span);
        // (skip a sample either side of a jump: a hold's step and the loop wrap)
        const near = [6500, 7000, loop.start, loop.end].some((j) => Math.abs(tick - j) < 0.1) || Math.abs(((i / SR) * 1920) % span) < 0.1 || span - (((i / SR) * 1920) % span) < 0.1;
        if (near) continue;
        lanErr = Math.max(lanErr, Math.abs(curves.domainPos(spec, Lv[i] as number) - curves.domainPos(spec, auto.valueAt(points, tick, spec))));
      }
      out[k] = { liveVsExport: d, vsLane: lanErr, events: live.length };
    }
    return out;
  });
  console.log('AudioParam probe:', JSON.stringify(r));
  for (const k of ['lin', 'exp']) {
    // live and export: the same curve (float32 rendering)
    expect(r[k]!.liveVsExport, k).toBeLessThan(1e-5);
    // within 0.1 % of the parameter's range of the exact shape (plus float32 rounding)
    expect(r[k]!.vsLane, k).toBeLessThan(0.0011);
    expect(r[k]!.events, k).toBeGreaterThan(50);
  }
});

test('drum pad Decay (an exp-curve parameter) is read on its log scale at each hit, as the lane draws it', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __phasr: Record<string, any> };
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { projectStore, renderProjectToWav, engine } = w.__phasr;
    const { createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const base = projectStore.getState().project;
    const SR = 48000;
    const t = createTrack('instrument', 0, defs.INSTRUMENTS.drumrack.createConfig());
    t.id = 't';
    // the crash pad (long), one hit halfway along a straight Decay segment 0.05 s → 2 s
    const crash = t.instrument.kit.pads.findIndex((p: any) => /crash/i.test(p.name));
    t.instrument.kit.pads[crash] = { ...t.instrument.kit.pads[crash], decay: 4, source: { ...t.instrument.kit.pads[crash].source, length: 2.5 } };
    t.automation = [{ id: 'L', enabled: true, target: { kind: 'inst', param: `p${crash}.decay` }, points: [{ id: '1', tick: 0, value: 0.05 }, { id: '2', tick: 3840, value: 2 }] }];
    const c = createMidiClip('t', 0, 7680);
    c.id = 'c';
    c.notes = [{ id: 'n', pitch: 36 + crash, start: 1920, length: 240, velocity: 100 }];
    const out = (await renderProjectToWav({ ...base, bpm: 120, tracks: [t], clips: { c }, sends: base.sends.map((s: any) => ({ ...s, effects: [] })), master: { ...base.master, effects: [] } }, engine.assets, { sampleRate: SR, range: 'song', tail: false, format: 'float32' })).audio.left as Float32Array;
    const e = (a: number, b: number) => {
      let s = 0;
      for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) s += (out[i] as number) ** 2;
      return 10 * Math.log10(s / ((b - a) * SR) + 1e-30);
    };
    // the hit is at 1 s: its first 100 ms against 0.5–0.9 s after it
    return { head: e(1, 1.1), late: e(1.5, 1.9) };
  });
  console.log('Decay read at the hit:', JSON.stringify(r));
  // geometric halfway = √(0.05 · 2) ≈ 0.32 s: the hit has ended by 0.5 s after it (a linear read, 1.03 s, would still ring)
  expect(r.head - r.late).toBeGreaterThan(60);
});
