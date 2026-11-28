/**
 * Touch screens (iPad): every control driven by fingers, emulating an iPad Pro 11 in landscape.
 *
 * Chromium: the fingers are real touch input (CDP Input.dispatchTouchEvent) that goes through the
 * browser's own gesture handling — touch-action, scrolling, pinch-zoom and the pointercancel that ends a
 * drag the browser takes over — so these tests show a drag turns the control AND nothing scrolled.
 *
 * WebKit (playwright.webkit.config.ts): Playwright can only tap natively there, so taps are real and drags
 * are synthetic touch pointer events (the harness routes a finger's events to the element it pressed, as
 * pointer capture would); those exercise the app's touch handling in WebKit, and the controls' computed
 * touch-action is checked, but not WebKit's own scrolling — see README → Browser support.
 */
import { devices, expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
const { defaultBrowserType: _browser, ...IPAD } = devices['iPad Pro 11 landscape'];
test.use({ ...IPAD });
test.describe.configure({ timeout: 90_000 });

const PPQ = 960;
const TRACK_H = 78;
type Pt = { x: number; y: number };

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}
const project = (page: Page): Promise<any> => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project);
const ui = (page: Page): Promise<any> => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __phasr: Phasr }).__phasr.uiStore.getState())));

/**
 * Fingers on the screen. `gesture` moves one or more fingers along their paths together (finger f at
 * paths[f][i] at step i), holding `holdMs` before the first move.
 */
class Touchscreen {
  private cdp: CDPSession | null = null;
  constructor(
    private readonly page: Page,
    readonly native: boolean,
  ) {}

  static async on(page: Page, browserName: string): Promise<Touchscreen> {
    const t = new Touchscreen(page, browserName === 'chromium');
    if (t.native) t.cdp = await page.context().newCDPSession(page);
    else
      await page.evaluate(() => {
        // synthetic pointers have no browser-side capture: the harness routes each finger to its element
        Element.prototype.setPointerCapture = function () {};
        Element.prototype.releasePointerCapture = function () {};
      });
    return t;
  }

  async gesture(paths: Pt[][], opts: { stepMs?: number; holdMs?: number } = {}): Promise<void> {
    const steps = Math.max(...paths.map((p) => p.length));
    const at = (f: number, i: number) => paths[f]![Math.min(i, paths[f]!.length - 1)]!;
    const stepMs = opts.stepMs ?? 16;
    if (this.cdp) {
      // (Chromium, like iPadOS, also snaps a touch onto a control nearby — "touch adjustment" — so a touch beside a
      // control can reach it either way here; the WebKit run, which presses exactly what's under the point, checks
      // the app's own finger margins)
      const pts = (i: number) => paths.map((_, f) => ({ ...at(f, i), id: f + 1, radiusX: 8, radiusY: 8, force: 1 }));
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(0) });
      if (opts.holdMs) await this.page.waitForTimeout(opts.holdMs);
      for (let i = 1; i < steps; i++) {
        await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(i) });
        await this.page.waitForTimeout(stepMs);
      }
      // (a finger comes to rest before it lifts: the last move reaches the page first)
      await this.page.waitForTimeout(50);
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.page.evaluate(
        async ({ paths, holdMs, stepMs }) => {
          const fire = (el: Element, type: string, f: number, p: { x: number; y: number }) =>
            el.dispatchEvent(
              new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 100 + f, pointerType: 'touch', isPrimary: f === 0, clientX: p.x, clientY: p.y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, width: 16, height: 16, pressure: type === 'pointerup' ? 0 : 0.5 }),
            );
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const steps = Math.max(...paths.map((p) => p.length));
          const pos = (f: number, i: number) => paths[f]![Math.min(i, paths[f]!.length - 1)]!;
          const targets = paths.map((p) => document.elementFromPoint(p[0]!.x, p[0]!.y) as Element);
          targets.forEach((el, f) => fire(el, 'pointerdown', f, pos(f, 0)));
          if (holdMs) await wait(holdMs);
          for (let i = 1; i < steps; i++) {
            targets.forEach((el, f) => fire(el, 'pointermove', f, pos(f, i)));
            await wait(stepMs);
          }
          targets.forEach((el, f) => fire(el, 'pointerup', f, pos(f, steps - 1)));
        },
        { paths, holdMs: opts.holdMs ?? 0, stepMs },
      );
    }
    await this.page.waitForTimeout(60);
  }

  /** one finger from a to b in `n` steps */
  drag(a: Pt, b: Pt, n = 10, holdMs = 0): Promise<void> {
    return this.gesture([line(a, b, n)], { holdMs });
  }

  /** a finger resting still for `ms` (a long-press), then lifted */
  hold(p: Pt, ms = 650): Promise<void> {
    return this.gesture([[p, p]], { holdMs: ms });
  }

  async tap(p: Pt): Promise<void> {
    if (this.native) await this.gesture([[p]]);
    else await this.page.touchscreen.tap(p.x, p.y);
  }
}

function line(a: Pt, b: Pt, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

const centre = async (l: Locator): Promise<Pt> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** every scroll position on the page and the zoom: a finger driving a control must change none of them */
const scrollState = (page: Page): Promise<string> =>
  page.evaluate(() =>
    JSON.stringify([
      window.scrollX,
      window.scrollY,
      window.visualViewport?.scale ?? 1,
      window.visualViewport?.offsetLeft ?? 0,
      window.visualViewport?.offsetTop ?? 0,
      ...[...document.querySelectorAll('*')].filter((e) => e.scrollTop || e.scrollLeft).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}:${e.scrollTop},${e.scrollLeft}`),
    ]),
  );

const touchAction = (l: Locator): Promise<string> => l.evaluate((el) => getComputedStyle(el).touchAction);

async function addTrack(page: Page, label: string): Promise<string> {
  const before = (await project(page)).tracks.length;
  await page.getByRole('button', { name: 'Add a track' }).tap();
  await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).tap();
  await expect.poll(async () => (await project(page)).tracks.length).toBe(before + 1);
  return (await project(page)).tracks.at(-1).id;
}

/** a frequency knob's position 0..1 (logarithmic; TriOsc's Cutoff spans 20 Hz – 20 kHz, the Auto-Filter's 30 Hz – 18 kHz) */
const freqPos = async (k: Locator, min = 20, max = 20000) => Math.log(Number(await k.getAttribute('aria-valuenow')) / min) / Math.log(max / min);
const cutoffPos = (k: Locator) => freqPos(k);
const filterPos = (k: Locator) => freqPos(k, 30, 18000);

test('a finger turns a filter knob in the device panel (the reported iPad bug): the full drag counts and nothing scrolls', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().tap();
  await page.getByTitle(/Insert Auto-Filter/).tap();
  const knob = page.getByRole('slider', { name: 'Cutoff', exact: true }).last();
  await expect(knob).toBeVisible();
  const n0 = await filterPos(knob);
  const s0 = await scrollState(page);
  const c = await centre(knob);
  // 40 px up = +0.24 of the range (the knob's drag rate, 0.006 per px — the same as with a mouse)
  await ts.drag(c, { x: c.x, y: c.y - 40 }, 10);
  expect((await filterPos(knob)) - n0).toBeCloseTo(0.24, 2);
  expect(await scrollState(page)).toBe(s0);
  // and back down, from a touch just beside the drawn knob (a finger's larger area)
  const b = (await knob.boundingBox())!;
  await ts.drag({ x: b.x - 3, y: c.y }, { x: b.x - 3, y: c.y + 30 }, 8);
  expect((await filterPos(knob)) - n0).toBeCloseTo(0.06, 2);
  expect(await scrollState(page)).toBe(s0);
  // (why: the browser leaves a drag on it to the page — no panning, no zoom)
  expect(await touchAction(knob)).toBe('none');
});

test('the TriOsc window: its filter knob, two knobs at once, and a pinch on a knob does not zoom the page', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  await page.getByTitle('Open TriOsc').last().tap();
  const cutoff = page.getByRole('slider', { name: 'Cutoff', exact: true }).first();
  const reso = page.getByRole('slider', { name: 'Reso', exact: true }).first();
  await expect(cutoff).toBeVisible();
  const s0 = await scrollState(page);
  // (Cutoff starts fully open: turn it down)
  const n0 = await cutoffPos(cutoff);
  const c = await centre(cutoff);
  await ts.drag(c, { x: c.x, y: c.y + 40 }, 8);
  expect((await cutoffPos(cutoff)) - n0).toBeCloseTo(-0.24, 2);
  // two fingers, two knobs, at the same time: each turns its own
  const r0 = Number(await reso.getAttribute('aria-valuenow'));
  const n1 = await cutoffPos(cutoff);
  const cr = await centre(reso);
  await ts.gesture([line(c, { x: c.x, y: c.y + 30 }, 10), line(cr, { x: cr.x, y: cr.y - 30 }, 10)]);
  expect((await cutoffPos(cutoff)) - n1).toBeCloseTo(-0.18, 2);
  expect(Number(await reso.getAttribute('aria-valuenow'))).toBeGreaterThan(r0);
  // a pinch on a knob: no page zoom, no scroll
  if (ts.native) {
    await ts.gesture([line({ x: c.x - 4, y: c.y }, { x: c.x - 60, y: c.y }, 10), line({ x: c.x + 4, y: c.y }, { x: c.x + 60, y: c.y }, 10)]);
    expect(await scrollState(page)).toBe(s0);
  }
});

test('a mixer fader and the track header volume slider follow a finger, from beside them too', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  const name = (await project(page)).tracks[index].name;
  await page.keyboard.press('F9');
  const fader = page.getByRole('slider', { name: `${name} volume`, exact: true }).first();
  await expect(fader).toBeVisible();
  const s0 = await scrollState(page);
  const db0 = Number(await fader.getAttribute('aria-valuenow'));
  const fb = (await fader.boundingBox())!;
  // a finger 6 px to the right of the 21 px fader still grabs it (its touch area is wider)
  await ts.drag({ x: fb.x + fb.width + 6, y: fb.y + fb.height * 0.4 }, { x: fb.x + fb.width + 6, y: fb.y + fb.height * 0.4 + 25 }, 8);
  expect(Number(await fader.getAttribute('aria-valuenow'))).toBeLessThan(db0 - 3);
  expect(await scrollState(page)).toBe(s0);
  await page.keyboard.press('F9');
  // the header's slider (14 px tall): a finger 10 px below it moves it
  const hs = page.getByRole('slider', { name: 'Volume', exact: true }).nth(index);
  const hb = (await hs.boundingBox())!;
  const v0 = Number(await hs.getAttribute('aria-valuenow'));
  const thumbX = hb.x + 6 + ((v0 + 60) / 66) * (hb.width - 12);
  await ts.drag({ x: thumbX, y: hb.y + hb.height + 10 }, { x: thumbX - 40, y: hb.y + hb.height + 10 }, 8);
  expect(Number(await hs.getAttribute('aria-valuenow'))).toBeLessThan(v0 - 5);
  expect(await scrollState(page)).toBe(s0);
  expect(await touchAction(hs)).toBe('none');
});

test('Spectra EQ: hold empty space to add a band, drag its node, hold the node for its menu', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  const trackId = await addTrack(page, 'TriOsc');
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().tap();
  await page.getByTitle(/Insert Spectra EQ/).tap();
  const graph = page.locator('canvas[title^="Double-click: add band"]').last();
  await expect(graph).toBeVisible();
  const bands = async () => (await project(page)).tracks.find((t: any) => t.id === trackId).effects[0].params.bands.filter((b: any) => b.enabled);
  const before = (await bands()).length;
  const gb = (await graph.boundingBox())!;
  const at = { x: gb.x + gb.width * 0.55, y: gb.y + gb.height * 0.3 };
  const s0 = await scrollState(page);
  await ts.hold(at);
  await expect.poll(async () => (await bands()).length).toBe(before + 1);
  const added = (await bands()).find((b: any) => b.gain > 3)!;
  // drag the node it made (a finger 10 px off the node still has it): down and to the right
  await ts.drag({ x: at.x + 10, y: at.y + 6 }, { x: at.x + 70, y: at.y + 46 }, 10);
  const moved = (await bands()).find((b: any) => Math.abs(b.freq - added.freq) > 1)!;
  expect(moved.freq).toBeGreaterThan(added.freq);
  expect(moved.gain).toBeLessThan(added.gain);
  expect(await scrollState(page)).toBe(s0);
  // hold the node: its menu (the right-click)
  await ts.hold({ x: at.x + 60, y: at.y + 40 });
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await touchAction(graph)).toBe('none');
});

test('timeline: hold for the menus, drag a clip, one finger on empty space scrolls; piano roll: tap a note in, drag it, resize it, scroll the roll', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  const lanes = page.getByTestId('lanes');
  const lb = (await lanes.boundingBox())!;
  const { pxPerBeat, scrollX } = await ui(page);
  const X = (tick: number) => lb.x + (tick / PPQ) * pxPerBeat - scrollX;
  const yMid = lb.y + index * TRACK_H + 39;
  // hold empty lane space: the lane menu → New MIDI clip
  await ts.hold({ x: X(4 * PPQ), y: yMid });
  await page.getByRole('menu').getByRole('menuitem', { name: /New MIDI clip/ }).tap();
  const clipOf = async () => {
    const p = await project(page);
    return Object.values(p.clips).find((c: any) => c.trackId === p.tracks[index].id) as any;
  };
  await expect.poll(async () => !!(await clipOf())).toBe(true);
  const c0 = await clipOf();
  await page.keyboard.press('Escape');
  // drag the clip by its middle two beats to the right: it moves (snapped), nothing scrolls
  const s0 = await scrollState(page);
  const cx = X(c0.start + c0.length / 2);
  await ts.drag({ x: cx, y: yMid }, { x: cx + 2 * pxPerBeat, y: yMid }, 12);
  await expect.poll(async () => (await clipOf()).start).toBe(c0.start + 2 * PPQ);
  expect(await scrollState(page)).toBe(s0);
  // one finger on empty space scrolls the arrangement sideways (the mouse's time selection is a drag there)
  const sx0 = (await ui(page)).scrollX;
  await ts.drag({ x: lb.x + 400, y: yMid + TRACK_H }, { x: lb.x + 200, y: yMid + TRACK_H }, 10);
  expect((await ui(page)).scrollX).toBeCloseTo(sx0 + 200, 0);
  // hold the clip: its menu → Open in piano roll
  const c1 = await clipOf();
  const { scrollX: sxNow } = await ui(page);
  const X2 = (tick: number) => lb.x + (tick / PPQ) * pxPerBeat - sxNow;
  await ts.hold({ x: X2(c1.start + c1.length / 2), y: yMid });
  await page.getByRole('menu').getByRole('menuitem', { name: /Open in piano roll/ }).tap();
  await expect.poll(async () => (await ui(page)).editorClipId).toBe(c1.id);

  // the piano roll (96 px per beat, 14 px rows, keys 64 px wide)
  const roll = page.locator('[data-own-shortcuts] canvas').first();
  const rb = (await roll.boundingBox())!;
  const notes = async () => (await project(page)).clips[c1.id].notes;
  const y0 = rb.y + rb.height / 2;
  await ts.tap({ x: rb.x + 64 + 10, y: y0 });
  await expect.poll(async () => (await notes()).length).toBe(1);
  const n0 = (await notes())[0];
  // drag it by its body two beats right and three rows up (a finger 9 px below the 14 px row still holds it)
  await ts.drag({ x: rb.x + 64 + 5, y: y0 + 9 }, { x: rb.x + 64 + 5 + 192, y: y0 + 9 - 42 }, 12);
  await expect.poll(async () => (await notes())[0].start).toBe(n0.start + 2 * PPQ);
  expect((await notes())[0].pitch).toBe(n0.pitch + 3);
  // resize it from its right edge: a beat longer
  const n1 = (await notes())[0];
  const right = rb.x + 64 + ((n1.start + n1.length) / PPQ) * 96;
  const yRow = y0 - 42;
  await ts.drag({ x: right - 6, y: yRow }, { x: right - 6 + 96, y: yRow }, 10);
  await expect.poll(async () => (await notes())[0].length).toBe(n1.length + PPQ);
  // one finger on empty space scrolls the roll (no note, no selection box)
  const thumb = page.getByTestId('pr-hscroll-thumb');
  const t0 = await thumb.evaluate((el) => (el as HTMLElement).style.left);
  await ts.drag({ x: rb.x + 64 + 500, y: rb.y + 60 }, { x: rb.x + 64 + 200, y: rb.y + 60 }, 10);
  expect(await thumb.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(t0);
  expect(await notes()).toHaveLength(1);
  expect([await touchAction(lanes), await touchAction(roll)]).toEqual(['none', 'none']);
});

test('automation by touch: tap points in, the segment handle shows and bends with a finger, hold for the shape menu', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  await page.locator('select[title^="Automation lane shown"]').nth(index).selectOption('+pan');
  await expect.poll(async () => (await ui(page)).automationMode).toBe(true);
  const lane = async () => (await project(page)).tracks[index].automation[0];
  const lb = (await page.getByTestId('lanes').boundingBox())!;
  const { pxPerBeat, scrollX } = await ui(page);
  const top = index * TRACK_H + 17;
  const h = TRACK_H - 23;
  const X = (tick: number) => lb.x + (tick / PPQ) * pxPerBeat - scrollX;
  const Y = (v: number) => lb.y + top + (1 - (v + 1) / 2) * h;
  const s0 = await scrollState(page);
  await ts.tap({ x: X(4 * PPQ), y: Y(-0.8) });
  await ts.tap({ x: X(12 * PPQ), y: Y(0.8) });
  await expect.poll(async () => (await lane()).points.length).toBe(3);
  const [, a, b] = (await lane()).points;
  // the last tapped point is selected, so its segment's handle shows mid-segment: drag it down
  const xm = (X(a.tick) + X(b.tick)) / 2;
  const ym = (Y(a.value) + Y(b.value)) / 2;
  await ts.drag({ x: xm + 8, y: ym + 6 }, { x: xm + 8, y: ym + 20 }, 8);
  const bent = (await lane()).points[1].shape;
  expect(bent?.type).toBe('curve');
  expect(bent.amount).toBeGreaterThan(0.2);
  expect(await scrollState(page)).toBe(s0);
  // hold the segment: the shape menu
  await ts.hold({ x: X(a.tick) + (X(b.tick) - X(a.tick)) * 0.25, y: Y(0.5) });
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Hold' }).tap();
  expect((await lane()).points[1].shape).toEqual({ type: 'hold' });
  // a finger dragging empty lane space scrolls instead of drawing
  const sx0 = (await ui(page)).scrollX;
  await ts.drag({ x: X(16 * PPQ), y: Y(0) }, { x: X(16 * PPQ) - 200, y: Y(0) }, 10);
  expect((await ui(page)).scrollX).toBeGreaterThan(sx0);
  expect((await lane()).points).toHaveLength(3);
});

test('the on-screen keyboard plays a three-finger chord; the first touch starts the audio', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  await page.getByTitle('Open TriOsc').last().tap();
  const events: string[] = [];
  await page.exposeFunction('__note', (s: string) => events.push(s));
  await page.evaluate(() => {
    const { engine } = (window as unknown as { __phasr: Phasr }).__phasr;
    engine.onLiveInput((e: { type: string; note?: number }) => (e.type === 'noteOn' || e.type === 'noteOff') && (window as unknown as { __note: (s: string) => void }).__note(e.type === 'noteOn' ? `on ${e.note}` : 'off'));
  });
  const key = (n: number) => page.locator(`[data-note="${n}"]`).first();
  const pts = await Promise.all([60, 64, 67].map(async (n) => {
    const b = (await key(n).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height * 0.85 };
  }));
  await ts.gesture(pts.map((p) => [p, p, p]), { holdMs: 150 });
  // all three held together: three notes on, then three off when the fingers lift (not one at a time)
  await expect.poll(() => events.length).toBe(6);
  expect(events.slice(0, 3).sort()).toEqual(['on 60', 'on 64', 'on 67']);
  expect(events.slice(3)).toEqual(['off', 'off', 'off']);
  // audio suspended (as on an iPad before any touch): the end of a touch starts it — iPadOS only lets audio start
  // from there (not from the press, which already resumes it in other browsers), so the touch's end alone must do it
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.ctx.suspend());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.ctx.state)).toBe('suspended');
  await page.evaluate(() => window.dispatchEvent(new Event('touchend')));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.ctx.state)).toBe('running');
});

test('tooltips by touch: a finger resting on a button shows its tooltip (and does not press it); a tap presses it', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  const index = (await project(page)).tracks.length - 1;
  const mute = page.getByTitle('Mute', { exact: true }).nth(index);
  await ts.gesture([[await centre(mute), await centre(mute)]], { holdMs: 700 });
  // (the tooltip shows while the finger rests; it's gone once it lifts)
  expect((await project(page)).tracks[index].mute).toBe(false);
  await ts.tap(await centre(mute));
  await expect.poll(async () => (await project(page)).tracks[index].mute).toBe(true);
  // while resting: shown
  const c = await centre(page.getByTitle('Solo', { exact: true }).nth(index));
  const shown = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const obs = new MutationObserver(() => {
          const t = document.querySelector('[data-testid="touch-tooltip"]');
          if (t) {
            obs.disconnect();
            resolve(t.textContent ?? '');
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
      }),
  );
  await ts.gesture([[c, c]], { holdMs: 700 });
  expect(await shown).toBe('Solo');
  await expect(page.getByTestId('touch-tooltip')).toHaveCount(0);
});

test('a window follows a finger on its title bar; the page does not scroll', async ({ page, browserName }) => {
  await openApp(page);
  const ts = await Touchscreen.on(page, browserName);
  await addTrack(page, 'TriOsc');
  await page.getByTitle('Open TriOsc').last().tap();
  const bar = page.getByText('TRIOSC', { exact: true }).locator('xpath=ancestor::div[contains(@class,"cursor-move")][1]').first();
  await expect(bar).toBeVisible();
  const b0 = (await bar.boundingBox())!;
  const s0 = await scrollState(page);
  const from = { x: b0.x + 90, y: b0.y + b0.height / 2 };
  await ts.drag(from, { x: from.x + 60, y: from.y + 40 }, 10);
  const b1 = (await bar.boundingBox())!;
  expect([Math.round(b1.x - b0.x), Math.round(b1.y - b0.y)]).toEqual([60, 40]);
  expect(await scrollState(page)).toBe(s0);
});

test('no double-tap zoom (no 300 ms click delay) anywhere; controls take no callout', async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('manipulation');
  expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).toBe('manipulation');
  for (const l of [page.getByTestId('lanes'), page.getByRole('slider', { name: 'Volume', exact: true }).first()]) expect(await touchAction(l)).toBe('none');
});
