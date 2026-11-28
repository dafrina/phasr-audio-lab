/**
 * Mouse behaviour must not change when touch support changes: knob and fader
 * drag sensitivity (and Shift fine-adjust), wheel steps, double-click resets,
 * right-click menus, the clip click/drag threshold, wheel zoom and scrolling,
 * window dragging, the on-screen keyboard, cursors, tooltips and hit areas.
 *
 * BASELINE holds the values measured with the real mouse on the code before
 * touch support (commit 1c37fd6); the test measures the same gestures now and
 * expects exactly the same numbers. `MOUSE_BASELINE=record` prints them instead.
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
test.describe.configure({ timeout: 90_000 });
const PPQ = 960;

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}
const project = (page: Page): Promise<any> => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project);
const ui = (page: Page): Promise<any> => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __phasr: Phasr }).__phasr.uiStore.getState())));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

async function addTrack(page: Page, label: string): Promise<string> {
  const before = (await project(page)).tracks.length;
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click();
  await expect.poll(async () => (await project(page)).tracks.length).toBe(before + 1);
  return (await project(page)).tracks.at(-1).id;
}

/** drag from the centre of a box by (dx, dy) in `steps` moves, optionally holding Shift */
async function dragBy(page: Page, b: { x: number; y: number; width: number; height: number }, dx: number, dy: number, shift = false, at?: { x: number; y: number }) {
  const x0 = at?.x ?? b.x + b.width / 2;
  const y0 = at?.y ?? b.y + b.height / 2;
  await page.mouse.move(x0, y0);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(x0 + dx, y0 + dy, { steps: 6 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

// recorded with MOUSE_BASELINE=record on 1c37fd6 (before touch support), Chromium 1280×720
const BASELINE: Record<string, unknown> = {"knob":{"size":[34,34],"cursor":"ns-resize","title":"Mix: 50% · right-click to automate or sidechain","drag20":0.12,"shiftDrag20":0.024,"wheelUp":0.02,"outside":0,"dblClick":0.5,"menu":["Automate this parameter","Sidechain from Audio 1 (audio)","Sidechain from TriOsc 2 (MIDI notes)","Sidechain from TriOsc 2 (audio)","Sidechain from TriOsc 3 (MIDI notes)"]},"fader":{"size":[21,96],"cursor":"ns-resize","title":"TriOsc 3 volume — drag, Shift for fine, double-click for 0 dB","drag30":-14.8,"shiftDrag30":-3.7,"wheelUp":0.5,"dblClick":0},"hslider":{"size":[207,14],"cursor":"ew-resize","drag20":6.7,"shiftDrag20":1.3,"jump":-44.3,"dblClick":0},"clip":{"after3px":0,"after6pxShift":144,"after40px":960,"cursorBody":"grab","cursorEdge":"ew-resize","menu":["Open in piano rollDbl-click","Rename…","Export as MIDI file (.mid)","Split at playheadShift+S","DuplicateCtrl+D","Loop contentCtrl+L","CopyCtrl+C","DeleteDel"]},"wheel":{"zoom":1.284,"shiftScroll":100,"knobWheelScrollsPanel":false},"window":{"moved":[40,25]},"keyboard":{"down":[60],"glide":[62],"up":[]}};

test('mouse behaviour is unchanged: knobs, faders, sliders, clips, wheel, windows, keyboard', async ({ page }) => {
  await openApp(page);
  const m: Record<string, any> = {};
  const trackId = await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;

  // --- a knob: Phaser Mix (0..1, linear)
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().click();
  await page.getByTitle('Insert Phaser at the end of the chain').click();
  const mix = () => page.getByRole('slider', { name: 'Mix', exact: true }).last();
  const mixVal = async () => Number(await mix().getAttribute('aria-valuenow'));
  const kb = (await mix().boundingBox())!;
  const v0 = await mixVal();
  m.knob = { size: [r4(kb.width), r4(kb.height)], cursor: await mix().evaluate((el) => getComputedStyle(el).cursor), title: await mix().evaluate((el) => el.parentElement?.parentElement?.getAttribute('title')) };
  await dragBy(page, kb, 0, -20);
  m.knob.drag20 = r4((await mixVal()) - v0);
  const v1 = await mixVal();
  await dragBy(page, kb, 0, -20, true);
  m.knob.shiftDrag20 = r4((await mixVal()) - v1);
  const v2 = await mixVal();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(mixVal).not.toBe(v2);
  m.knob.wheelUp = r4((await mixVal()) - v2);
  // a press just outside the knob's drawn circle area (3 px left of its box) moves nothing
  const v3 = await mixVal();
  await dragBy(page, kb, 0, -20, false, { x: kb.x - 3, y: kb.y + kb.height / 2 });
  m.knob.outside = r4((await mixVal()) - v3);
  await mix().dblclick();
  m.knob.dblClick = await mixVal();
  await mix().click({ button: 'right' });
  m.knob.menu = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  // the wheel over a knob turns it and doesn't scroll the device panel
  const panel = mix().locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
  const st0 = await panel.evaluate((el) => [el.scrollTop, el.scrollLeft]);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.wheel(0, 100);
  const knobWheelScrollsPanel = JSON.stringify(await panel.evaluate((el) => [el.scrollTop, el.scrollLeft])) !== JSON.stringify(st0);

  // --- a fader in the mixer
  await page.keyboard.press('F9');
  const fader = page.getByRole('slider', { name: `${(await project(page)).tracks[index].name} volume`, exact: true }).first();
  await expect(fader).toBeVisible();
  const fb = (await fader.boundingBox())!;
  const fval = async () => Number(await fader.getAttribute('aria-valuenow'));
  m.fader = { size: [r4(fb.width), r4(fb.height)], cursor: await fader.evaluate((el) => getComputedStyle(el).cursor), title: await fader.getAttribute('title') };
  await fader.dblclick();
  const f0 = await fval();
  // (down from 0 dB: room to move both ways)
  await dragBy(page, fb, 0, 30, false, { x: fb.x + fb.width / 2, y: fb.y + fb.height * 0.3 });
  m.fader.drag30 = r4((await fval()) - f0);
  const f1 = await fval();
  await dragBy(page, fb, 0, 30, true, { x: fb.x + fb.width / 2, y: fb.y + fb.height * 0.3 });
  m.fader.shiftDrag30 = r4((await fval()) - f1);
  await fader.dblclick();
  const f2 = await fval();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(fval).not.toBe(f2);
  m.fader.wheelUp = r4((await fval()) - f2);
  await fader.dblclick();
  m.fader.dblClick = await fval();
  await page.keyboard.press('F9');

  // --- the track header's volume slider
  const hs = page.getByRole('slider', { name: 'Volume', exact: true }).nth(index);
  const hb = (await hs.boundingBox())!;
  const hval = async () => Number(await hs.getAttribute('aria-valuenow'));
  m.hslider = { size: [r4(hb.width), r4(hb.height)], cursor: await hs.evaluate((el) => getComputedStyle(el).cursor) };
  await hs.dblclick();
  const h0 = await hval();
  // the thumb sits at 0 dB; grab it there and drag
  const thumbX = hb.x + 6 + ((0 + 60) / 66) * (hb.width - 12);
  await dragBy(page, hb, -20, 0, false, { x: thumbX, y: hb.y + hb.height / 2 });
  m.hslider.drag20 = r4(h0 - (await hval()));
  const h1 = await hval();
  const thumb1 = hb.x + 6 + ((h1 + 60) / 66) * (hb.width - 12);
  await dragBy(page, hb, -20, 0, true, { x: thumb1, y: hb.y + hb.height / 2 });
  m.hslider.shiftDrag20 = r4(h1 - (await hval()));
  await page.mouse.click(hb.x + hb.width * 0.25, hb.y + hb.height / 2);
  m.hslider.jump = await hval();
  await hs.dblclick();
  m.hslider.dblClick = await hval();

  // --- a clip: a press that moves 3 px changes nothing; 40 px moves it (snapped); cursors; its menu
  const lanes = page.getByTestId('lanes');
  await lanes.dblclick({ position: { x: 12, y: index * 78 + 39 } });
  await expect.poll(async () => (await ui(page)).editorClipId).toBeTruthy();
  const clipId = (await ui(page)).editorClipId;
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const lb = (await lanes.boundingBox())!;
  const { pxPerBeat, scrollX } = await ui(page);
  const c0 = (await project(page)).clips[clipId];
  const cx = lb.x + ((c0.start + c0.length / 2) / PPQ) * pxPerBeat - scrollX;
  const cy = lb.y + index * 78 + 39;
  await page.mouse.move(cx, cy);
  m.clip = {};
  await dragBy(page, lb, 3, 0, false, { x: cx, y: cy });
  m.clip.after3px = (await project(page)).clips[clipId].start - c0.start;
  // (Shift: no snap — a 6 px drag is past the 3 px threshold and moves it by 6 px worth of ticks)
  await dragBy(page, lb, 6, 0, true, { x: cx, y: cy });
  m.clip.after6pxShift = (await project(page)).clips[clipId].start - c0.start;
  await page.keyboard.press('Control+z');
  await dragBy(page, lb, 40, 0, false, { x: cx, y: cy });
  m.clip.after40px = (await project(page)).clips[clipId].start - c0.start;
  const c1 = (await project(page)).clips[clipId];
  const bodyX = lb.x + ((c1.start + c1.length / 2) / PPQ) * pxPerBeat - scrollX;
  await page.mouse.move(bodyX, cy);
  m.clip.cursorBody = await lanes.evaluate((el) => (el as HTMLElement).style.cursor);
  await page.mouse.move(lb.x + ((c1.start + c1.length) / PPQ) * pxPerBeat - scrollX - 2, cy);
  m.clip.cursorEdge = await lanes.evaluate((el) => (el as HTMLElement).style.cursor);
  await page.mouse.click(bodyX, cy, { button: 'right' });
  m.clip.menu = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');

  // --- the wheel: Ctrl+wheel zooms, Shift+wheel scrolls sideways; the wheel over a knob doesn't scroll its panel
  const px0 = (await ui(page)).pxPerBeat;
  await page.mouse.move(lb.x + 300, lb.y + 20);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await ui(page)).pxPerBeat).not.toBe(px0);
  const sx0 = (await ui(page)).scrollX;
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await ui(page)).scrollX).not.toBe(sx0);
  m.wheel = { zoom: r4((await ui(page)).pxPerBeat / px0), shiftScroll: r4((await ui(page)).scrollX - sx0), knobWheelScrollsPanel };

  // --- a window: dragging its title bar moves it by exactly the drag
  await page.getByTitle('Open TriOsc').nth(0).click();
  const title = page.getByText('TRIOSC', { exact: true }).locator('xpath=ancestor::div[contains(@class,"cursor-move")][1]').first();
  const winBox = async () => (await title.boundingBox())!;
  const w0 = await winBox();
  await dragBy(page, w0, 40, 25, false, { x: w0.x + 60, y: w0.y + w0.height / 2 });
  const w1 = await winBox();
  m.window = { moved: [r4(w1.x - w0.x), r4(w1.y - w0.y)] };

  // --- the on-screen keyboard: press, glide to the next white key, release
  const key = (n: number) => page.locator(`[data-note="${n}"]`).first();
  const active = async () => page.locator('[data-note]').evaluateAll((els) => els.filter((e) => /bg-accent/.test(e.className)).map((e) => Number(e.getAttribute('data-note'))));
  const k60 = (await key(60).boundingBox())!;
  const k62 = (await key(62).boundingBox())!;
  await page.mouse.move(k60.x + k60.width / 2, k60.y + k60.height * 0.85);
  await page.mouse.down();
  m.keyboard = { down: await active() };
  await page.mouse.move(k62.x + k62.width / 2, k62.y + k62.height * 0.85, { steps: 4 });
  m.keyboard.glide = await active();
  await page.mouse.up();
  m.keyboard.up = await active();
  expect(trackId).toBeTruthy();

  if (process.env.MOUSE_BASELINE === 'record') {
    console.log('MOUSE BASELINE', JSON.stringify(m));
    return;
  }
  expect(m).toEqual(BASELINE);
});
