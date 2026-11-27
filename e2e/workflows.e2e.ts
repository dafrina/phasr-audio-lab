/**
 * User workflows driven through the real UI (clicks and keys), the way a
 * person uses the app. `window.__phasr` is only read, for assertions — every
 * change is made with the mouse or the keyboard. Each test starts in a fresh
 * browser profile (empty storage → the default project).
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;

// UI workflows are quick; a hang should fail fast
test.describe.configure({ timeout: 60_000 });
const PPQ = 960;
/** piano roll geometry (src/ui/editor/PianoRoll.tsx defaults) */
const PR = { keysW: 64, pxPerBeat: 96, rowH: 14 };

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

const project = (page: Page): Promise<any> => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project);
const ui = (page: Page): Promise<any> => page.evaluate(() => {
  const s = (window as unknown as { __phasr: Phasr }).__phasr.uiStore.getState();
  return JSON.parse(JSON.stringify(s));
});
const persistStatus = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.session.usePersistStore.getState().status);

/** Add a track through the + under the track headers. */
async function addTrack(page: Page, label: string): Promise<string> {
  const before = (await project(page)).tracks.length;
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: label, exact: true }).click();
  await expect.poll(async () => (await project(page)).tracks.length).toBe(before + 1);
  return (await project(page)).tracks.at(-1).id;
}

/** Double-click a track's lane at bar 1: a new MIDI clip, opened in the piano roll. */
async function newClipOnTrack(page: Page, trackIndex: number): Promise<string> {
  const lanes = page.getByTestId('lanes');
  await lanes.dblclick({ position: { x: 12, y: trackIndex * 78 + 39 } });
  await expect.poll(async () => (await ui(page)).editorClipId).toBeTruthy();
  return (await ui(page)).editorClipId;
}

const notesOf = async (page: Page, clipId: string): Promise<any[]> => (await project(page)).clips[clipId].notes;

test('the + popup adds a track of the chosen type; Esc and clicking away close it without adding', async ({ page }) => {
  await openApp(page);
  const start = (await project(page)).tracks.length;
  // Esc closes
  await page.getByRole('button', { name: 'Add a track' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // clicking elsewhere closes
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByTestId('lanes').click({ position: { x: 600, y: 5 } });
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect((await project(page)).tracks.length).toBe(start);
  // each type adds its own kind of track, selected
  for (const [label, kind, type] of [
    ['TriOsc', 'instrument', 'triosc'],
    ['Drum Rack', 'instrument', 'drumrack'],
    ['Audio', 'audio', undefined],
  ] as const) {
    const id = await addTrack(page, label);
    const t = (await project(page)).tracks.at(-1);
    expect([t.kind, t.instrument?.type]).toEqual([kind, type]);
    expect((await ui(page)).selectedTrackId).toBe(id);
  }
  // one undo per add
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await project(page)).tracks.length).toBe(start);
});

test('piano roll: draw, move, resize and delete a note with the mouse; undo and redo walk the steps exactly', async ({ page }) => {
  await openApp(page);
  await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  const clipId = await newClipOnTrack(page, index);
  const roll = page.locator('[data-own-shortcuts] canvas').first();
  const box = (await roll.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });

  // draw: a click on empty grid drops a 1/16 note on the beat under the pointer
  const yClick = Math.round(box.height / 2);
  const p0 = at(PR.keysW + PR.pxPerBeat + 10, yClick);
  await page.mouse.click(p0.x, p0.y);
  await expect.poll(async () => (await notesOf(page, clipId)).length).toBe(1);
  const drawn = (await notesOf(page, clipId))[0];
  expect([drawn.start, drawn.length]).toEqual([PPQ, PPQ / 4]);
  const noteX = (n: any) => PR.keysW + (n.start / PPQ) * PR.pxPerBeat;
  const noteW = (n: any) => (n.length / PPQ) * PR.pxPerBeat;

  // move: two beats later, three semitones up
  const grab = at(noteX(drawn) + 5, yClick);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 2 * PR.pxPerBeat, grab.y - 3 * PR.rowH, { steps: 8 });
  await page.mouse.up();
  const moved = (await notesOf(page, clipId))[0];
  expect([moved.start, moved.pitch, moved.length]).toEqual([drawn.start + 2 * PPQ, drawn.pitch + 3, drawn.length]);

  // resize: drag the right edge one beat further
  const edge = at(noteX(moved) + noteW(moved) - 2, yClick - 3 * PR.rowH);
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + PR.pxPerBeat, edge.y, { steps: 8 });
  await page.mouse.up();
  const resized = (await notesOf(page, clipId))[0];
  expect([resized.start, resized.pitch, resized.length]).toEqual([moved.start, moved.pitch, moved.length + PPQ]);

  // delete: right-click the note
  const body = at(noteX(resized) + noteW(resized) / 2, yClick - 3 * PR.rowH);
  await page.mouse.click(body.x, body.y, { button: 'right' });
  await expect.poll(async () => (await notesOf(page, clipId)).length).toBe(0);

  // undo walks back one edit at a time, redo forward again
  const shape = (n: any) => (n ? [n.start, n.pitch, n.length] : null);
  const step = async (keys: string) => {
    await page.keyboard.press(keys);
    return shape((await notesOf(page, clipId))[0]);
  };
  expect(await step('Control+z')).toEqual(shape(resized));
  expect(await step('Control+z')).toEqual(shape(moved));
  expect(await step('Control+z')).toEqual(shape(drawn));
  expect(await step('Control+z')).toEqual(null);
  expect(await step('Control+Shift+z')).toEqual(shape(drawn));
  expect(await step('Control+y')).toEqual(shape(moved));
  expect(await step('Control+Shift+z')).toEqual(shape(resized));
  expect(await step('Control+y')).toEqual(null);
});

/** Drag a knob vertically by dy pixels (up = more). */
async function dragKnob(page: Page, knob: ReturnType<Page['getByRole']>, dy: number): Promise<void> {
  const b = (await knob.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - dy, { steps: 6 });
  await page.mouse.up();
}

test('add an effect from the device panel, turn a knob, pick a preset and an option; undo restores each', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().click();
  await page.getByTitle('Insert Phaser at the end of the chain').click();
  const fx = async () => (await project(page)).tracks.find((t: any) => t.id === trackId).effects;
  await expect.poll(async () => (await fx()).map((s: any) => s.type)).toEqual(['phaser']);
  const defaults = (await fx())[0].params;

  // a knob drag changes that one parameter
  await dragKnob(page, page.getByRole('slider', { name: 'Center', exact: true }), 40);
  const turned = (await fx())[0].params;
  expect(turned.center).toBeGreaterThan(defaults.center * 1.5);
  expect({ ...turned, center: 0 }).toEqual({ ...defaults, center: 0 });

  // an option button
  await page.getByRole('button', { name: '12', exact: true }).click();
  expect((await fx())[0].params.stages).toBe(12);

  // a factory preset sets all of its values
  await page.getByTitle('Effect preset').selectOption({ label: 'Slow Jet (4 bars)' });
  const preset = (await fx())[0].params;
  expect(preset).toMatchObject({ stages: 12, center: 900, depth: 2.6, feedback: 0.75, division: 16 });

  // undo: preset → stages → knob → the effect itself
  await page.keyboard.press('Control+z');
  expect((await fx())[0].params).toEqual({ ...turned, stages: 12 });
  await page.keyboard.press('Control+z');
  expect((await fx())[0].params).toEqual(turned);
  await page.keyboard.press('Control+z');
  expect((await fx())[0].params).toEqual(defaults);
  await page.keyboard.press('Control+z');
  expect(await fx()).toEqual([]);
});

test('automation: right-click a knob to create a lane, click points into it in Automation mode', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().click();
  await page.getByTitle('Insert Phaser at the end of the chain').click();
  const slotId = (await project(page)).tracks[index].effects[0].id;

  await page.getByRole('slider', { name: 'Center', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Automate this parameter' }).or(page.getByText('Automate this parameter')).first().click();
  const lanes = async () => (await project(page)).tracks[index].automation;
  await expect.poll(async () => (await lanes()).length).toBe(1);
  const lane = (await lanes())[0];
  expect(lane.target).toEqual({ kind: 'fx', slotId, param: 'center' });
  // the lane starts with the knob's value; Automation mode is on and the lane is shown
  expect(lane.points.map((p: any) => p.value)).toEqual([700]);
  const u = await ui(page);
  expect([u.automationMode, u.shownLanes[trackId]]).toEqual([true, lane.id]);

  // click a point in at bar 2, high in the lane, and another at bar 3, low
  const pxPerBeat = (await ui(page)).pxPerBeat;
  const scrollX = (await ui(page)).scrollX;
  const xAt = (tick: number) => (tick / PPQ) * pxPerBeat - scrollX;
  const laneCv = page.getByTestId('lanes');
  await laneCv.click({ position: { x: xAt(4 * PPQ), y: index * 78 + 12 } });
  await laneCv.click({ position: { x: xAt(8 * PPQ), y: index * 78 + 66 } });
  const pts = (await lanes())[0].points;
  expect(pts.map((p: any) => p.tick)).toEqual([0, 4 * PPQ, 8 * PPQ]);
  const [, hi, lo] = pts.map((p: any) => p.value);
  expect(hi).toBeGreaterThan(2000);
  expect(lo).toBeLessThan(300);
  // the knob now shows the automated value at the playhead (bar 1 = the first point)
  await expect(page.getByRole('slider', { name: 'Center', exact: true })).toHaveAttribute('aria-valuenow', '700');
  // undo removes the last point, then the one before
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await lanes())[0].points.map((p: any) => p.tick)).toEqual([0]);
});

test('save (Ctrl+S) and reload: the project comes back exactly', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  const index = (await project(page)).tracks.length - 1;
  const clipId = await newClipOnTrack(page, index);
  const roll = page.locator('[data-own-shortcuts] canvas').first();
  const box = (await roll.boundingBox())!;
  await page.mouse.click(box.x + PR.keysW + 10, box.y + box.height / 2);
  await page.mouse.click(box.x + PR.keysW + PR.pxPerBeat * 2 + 10, box.y + box.height / 2 - PR.rowH * 4);
  await expect.poll(async () => (await notesOf(page, clipId)).length).toBe(2);
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().click();
  await page.getByTitle('Insert Reverb Pro at the end of the chain').click();
  await page.getByTitle('Project name').fill('Workflow test');
  await page.getByTitle('Project name').press('Enter');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(page)).toBe('saved');
  const before = await project(page);
  expect(before.name).toBe('Workflow test');

  await page.reload();
  await openApp(page);
  const after = await project(page);
  expect(after).toEqual(before);
  expect(after.tracks.find((t: any) => t.id === trackId).effects.map((s: any) => s.type)).toEqual(['reverb']);
});

/** Parse a RIFF/WAVE file's fmt and data chunks. */
function parseWav(buf: Buffer): { format: number; channels: number; rate: number; bits: number; blockAlign: number; frames: number; riffOk: boolean; data: Buffer } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  let pos = 12;
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const blockAlign = fmt.readUInt16LE(12);
  return {
    format: fmt.readUInt16LE(0),
    channels: fmt.readUInt16LE(2),
    rate: fmt.readUInt32LE(4),
    bits: fmt.readUInt16LE(14),
    blockAlign,
    frames: data.length / blockAlign,
    riffOk: buf.readUInt32LE(4) === buf.length - 8,
    data,
  };
}

test('export: the WAV download is a valid file of exactly the song length (16-bit, no tail) and longer with the tail (float)', async ({ page }) => {
  await openApp(page);
  // one bar with a note on the default TriOsc track (index 1): the song is 2 s at 120 BPM
  const clipId = await newClipOnTrack(page, 1);
  const roll = page.locator('[data-own-shortcuts] canvas').first();
  const box = (await roll.boundingBox())!;
  await page.mouse.click(box.x + PR.keysW + 10, box.y + box.height / 2);
  await expect.poll(async () => (await notesOf(page, clipId)).length).toBe(1);

  const exportOnce = async (opts: { rate: number; format: string; tail: boolean }) => {
    await page.getByTitle('Export audio (WAV / MP3)…').click();
    await page.locator('select:has(option[value="44100"])').selectOption(String(opts.rate));
    await page.getByTestId('export-format').selectOption(opts.format);
    const tail = page.getByLabel('Include release & effect tails');
    if (opts.tail) await tail.check();
    else await tail.uncheck();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const file = parseWav(Buffer.from(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]))));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    return file;
  };

  const pcm = await exportOnce({ rate: 44100, format: 'pcm16', tail: false });
  expect(pcm).toMatchObject({ format: 1, channels: 2, rate: 44100, bits: 16, blockAlign: 4, riffOk: true, frames: 2 * 44100 });
  // there is sound: the note at the start
  let loud = 0;
  for (let i = 0; i < 44100 * 0.25; i++) loud = Math.max(loud, Math.abs(pcm.data.readInt16LE(i * 4)));
  expect(loud).toBeGreaterThan(1000);

  const flt = await exportOnce({ rate: 48000, format: 'float32', tail: true });
  expect(flt).toMatchObject({ format: 3, channels: 2, rate: 48000, bits: 32, blockAlign: 8, riffOk: true });
  expect(flt.frames).toBeGreaterThanOrEqual(2 * 48000);
  // the tail is trimmed to where the sound ends (+50 ms): the default patch releases quickly
  expect(flt.frames).toBeLessThan(2 * 48000 + 48000);
});

/** Record every note the computer keyboard plays: [trackId, note]. */
async function spyNotes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __phasr: Phasr; __notes: [string, number][] };
    const e = w.__phasr.engine;
    const orig = e.previewNoteOn.bind(e);
    w.__notes = [];
    e.previewNoteOn = (t: string, n: number, v: number) => {
      w.__notes.push([t, n]);
      return orig(t, n, v);
    };
  });
}
const takeNotes = (page: Page): Promise<[string, number][]> =>
  page.evaluate(() => {
    const w = window as unknown as { __notes: [string, number][] };
    const n = w.__notes;
    w.__notes = [];
    return n;
  });

test('window stacking: the window clicked last is in front and owns the computer keyboard; closing it hands the keys back', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  await spyNotes(page);
  await page.getByTitle('Open TriOsc').last().click();
  // add the Arp-Ape-ator from the device panel: its window opens too
  await page.getByTitle(/^Insert effects \(0\/4\)/).last().click();
  await page.getByRole('button', { name: 'Add ape' }).click();
  const arp = page.getByTestId('arp-window');
  const synth = page.locator('div.fixed', { has: page.getByText('TRIOSC', { exact: true }) });
  await expect(arp).toBeVisible();
  await expect(synth).toBeVisible();
  const z = (l: typeof arp) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));

  // the Arp window opened last: it's in front, and its keyboard plays (one octave up after ])
  expect(await z(arp)).toBeGreaterThan(await z(synth));
  await page.keyboard.press(']');
  await page.keyboard.press('z');
  expect(await takeNotes(page)).toEqual([[trackId, 72]]);

  // clicking the TriOsc window brings it to the front; its own keyboard is still at C4
  await synth.getByText('TRIOSC', { exact: true }).click();
  expect(await z(synth)).toBeGreaterThan(await z(arp));
  await page.keyboard.press('z');
  expect(await takeNotes(page)).toEqual([[trackId, 60]]);

  // closing the front window hands the keyboard back to the Arp window (still an octave up)
  await synth.getByTitle('Close (Esc)').click();
  await expect(synth).toHaveCount(0);
  await page.keyboard.press('z');
  expect(await takeNotes(page)).toEqual([[trackId, 72]]);
});

test('keyboard rules: letters play the selected track, Shift+letter runs song commands, Ctrl+letter edits, text fields keep their keys', async ({ page }) => {
  await openApp(page);
  const trackId = await addTrack(page, 'TriOsc');
  await spyNotes(page);
  const p0 = await project(page);

  await page.keyboard.press('z');
  await page.keyboard.press('l');
  await page.keyboard.press('m');
  expect(await takeNotes(page)).toEqual([[trackId, 60], [trackId, 73], [trackId, 71]]);
  expect([(await project(page)).loop.enabled, (await project(page)).metronome]).toEqual([p0.loop.enabled, p0.metronome]);

  // Shift+L / Shift+M toggle loop and metronome and play nothing
  await page.keyboard.press('Shift+L');
  await page.keyboard.press('Shift+M');
  expect(await takeNotes(page)).toEqual([]);
  expect([(await project(page)).loop.enabled, (await project(page)).metronome]).toEqual([!p0.loop.enabled, !p0.metronome]);
  // Shift+A toggles Automation mode
  const auto0 = (await ui(page)).automationMode;
  await page.keyboard.press('Shift+A');
  expect((await ui(page)).automationMode).toBe(!auto0);

  // Ctrl+Z undoes the song commands, one at a time (and plays nothing)
  await page.keyboard.press('Control+z');
  expect((await project(page)).metronome).toBe(p0.metronome);
  await page.keyboard.press('Control+z');
  expect((await project(page)).loop.enabled).toBe(p0.loop.enabled);
  expect(await takeNotes(page)).toEqual([]);

  // typing in a text field: letters are text, not notes or commands
  const name = page.getByTitle('Project name');
  await name.click();
  await name.press('End');
  await page.keyboard.type('zlm');
  await page.keyboard.press('Shift+L');
  expect(await takeNotes(page)).toEqual([]);
  expect((await project(page)).loop.enabled).toBe(p0.loop.enabled);
  await expect(name).toHaveValue(/zlmL$/);
});

/** The stored record of the open project (what a reload would bring back). */
const stored = (page: Page): Promise<any> =>
  page.evaluate(async () => {
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const db = await load('/src/persistence/db.ts');
    const id = (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project.id;
    const rec = await db.getProjectRecord(id);
    return rec ? JSON.parse(rec.data) : null;
  });

/** Make IndexedDB writes fail the given way (until restored). */
async function breakStorage(page: Page, how: 'quota' | 'quota-name-only' | 'abort-at-commit' | 'restore'): Promise<void> {
  await page.evaluate((how) => {
    const P = IDBObjectStore.prototype as any;
    const w = window as any;
    w.__origPut ??= P.put;
    const orig = w.__origPut;
    if (how === 'restore') P.put = orig;
    else if (how === 'quota')
      P.put = function () {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    else if (how === 'quota-name-only')
      // a quota error whose message doesn't say "quota" (the message text is up to the browser)
      P.put = function () {
        throw new DOMException('Not enough space.', 'QuotaExceededError');
      };
    else
      // the write "succeeds", then the transaction fails to commit (how IndexedDB reports a full disk)
      P.put = function (this: IDBObjectStore, ...a: unknown[]) {
        const r = orig.apply(this, a);
        const tx = this.transaction;
        r.addEventListener('success', () => {
          try {
            tx.abort();
          } catch {
            // already finished
          }
        });
        return r;
      };
  }, how);
}

test('storage full: saving fails with a clear toast, the project stays open and editable, and saving recovers', async ({ page }) => {
  await openApp(page);
  await breakStorage(page, 'quota');
  await addTrack(page, 'TriOsc');
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/browser storage is full/i).first()).toBeVisible();
  expect(await persistStatus(page)).toBe('error');
  // still editable
  await addTrack(page, 'Drum Rack');
  const n = (await project(page)).tracks.length;
  // space again: the next save works and keeps everything
  await breakStorage(page, 'restore');
  await page.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(page)).toBe('saved');
  expect((await stored(page)).tracks.length).toBe(n);
});

test('storage full is recognised by the error name, whatever the message says', async ({ page }) => {
  await openApp(page);
  await breakStorage(page, 'quota-name-only');
  await addTrack(page, 'TriOsc');
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/browser storage is full/i).first()).toBeVisible();
  expect(await persistStatus(page)).toBe('error');
});

test('a save whose transaction fails to commit is reported as failed, not "Saved"', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(page)).toBe('saved');
  const before = await stored(page);
  await breakStorage(page, 'abort-at-commit');
  await addTrack(page, 'TriOsc');
  await page.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(page)).not.toBe('saving');
  expect(await persistStatus(page)).toBe('error');
  await breakStorage(page, 'restore');
  expect((await stored(page)).tracks.length).toBe(before.tracks.length);
});

test('two tabs: the second is read-only; "Take over" moves ownership and keeps the newest saved work', async ({ context }) => {
  const a = await context.newPage();
  await openApp(a);
  await addTrack(a, 'TriOsc');
  await a.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(a)).toBe('saved');

  // tab B opens the same (last) project: read-only, says so, offers Take over
  const b = await context.newPage();
  await openApp(b);
  expect((await project(b)).id).toBe((await project(a)).id);
  expect(await persistStatus(b)).toBe('readonly');
  await expect(b.getByText(/open in another tab/i).first()).toBeVisible();
  await expect(b.getByRole('button', { name: 'Take over', exact: true })).toBeVisible();
  // B's edits are not saved
  await addTrack(b, 'Drum Rack');
  await b.keyboard.press('Control+s');
  await b.waitForTimeout(1600);
  expect((await stored(a)).tracks.length).toBe((await project(a)).tracks.length);

  // A keeps working and saving
  await a.bringToFront();
  await addTrack(a, 'Sampler');
  await a.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(a)).toBe('saved');
  const newest = await stored(a);
  expect(newest.tracks.at(-1).instrument.type).toBe('sampler');

  // B takes over: it now owns the project — and shows A's newest work instead of writing its stale copy over it
  await b.bringToFront();
  await b.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect.poll(() => persistStatus(b)).toBe('saved');
  expect((await stored(b)).tracks.map((t: any) => t.id)).toEqual(newest.tracks.map((t: any) => t.id));
  expect((await project(b)).tracks.map((t: any) => t.id)).toEqual(newest.tracks.map((t: any) => t.id));
  // and A is read-only now: its edits are no longer saved
  await expect.poll(() => persistStatus(a)).toBe('readonly');
  await expect(a.getByText(/another tab took over/i).first()).toBeVisible();
  await a.bringToFront();
  await addTrack(a, 'TriOsc');
  await a.waitForTimeout(1600);
  expect((await stored(b)).tracks.length).toBe(newest.tracks.length);
});

test('an edit made while a save is under way is not reported as saved', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { session, projectStore } = (window as unknown as { __phasr: Phasr }).__phasr;
    const saving = session.saveNow();
    // (the edit lands while the save is writing)
    projectStore.getState().commit('Rename', (p: any) => ({ ...p, name: 'edited during save' }));
    await saving;
    return session.usePersistStore.getState().status;
  });
  expect(r).toBe('dirty');
  // and it does get saved
  await expect.poll(() => persistStatus(page), { timeout: 5000 }).toBe('saved');
  expect((await stored(page)).name).toBe('edited during save');
});

test('leaving the page (tab hidden / closed) saves pending edits at once', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+s');
  await expect.poll(() => persistStatus(page)).toBe('saved');
  await addTrack(page, 'TriOsc');
  expect(await persistStatus(page)).toBe('dirty');
  const n = (await project(page)).tracks.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // well before the 1.2 s autosave timer would have fired
  await expect.poll(async () => (await stored(page)).tracks.length, { timeout: 600, intervals: [50] }).toBe(n);
});

test('arrangement: a click on a clip changes nothing (no undo step, no snap); Alt+click adds no hidden copy; Alt+drag duplicates', async ({ page }) => {
  await openApp(page);
  const clipId = await newClipOnTrack(page, 1);
  await page.keyboard.press('Escape');
  // put the clip slightly off the grid (as a recording started mid-beat would)
  await page.evaluate((id) => {
    const st = (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState();
    st.commit('off-grid', (p: any) => ({ ...p, clips: { ...p.clips, [id]: { ...p.clips[id], start: 965 } } }));
  }, clipId);
  const steps = () => page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().history.past.length as number);
  const u = await ui(page);
  const xAt = (tick: number) => (tick / PPQ) * u.pxPerBeat - u.scrollX;
  const lanes = page.getByTestId('lanes');
  const box = (await lanes.boundingBox())!;
  const p0 = { x: box.x + xAt(965 + PPQ), y: box.y + 78 + 50 };
  const before = await project(page);
  const n0 = await steps();

  // a click, with the hand wobbling a pixel
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 1, p0.y, { steps: 2 });
  await page.mouse.up();
  expect((await project(page)).clips[clipId].start).toBe(965);
  expect(await steps()).toBe(n0);

  // Alt+click: no copy left on top of the clip
  await page.keyboard.down('Alt');
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.up('Alt');
  expect(Object.keys((await project(page)).clips)).toEqual(Object.keys(before.clips));
  expect(await steps()).toBe(n0);

  // Alt+drag one bar to the right: a copy there (a dragged clip snaps to the grid), the original stays
  await page.keyboard.down('Alt');
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 4 * u.pxPerBeat, p0.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const clips = Object.values((await project(page)).clips) as any[];
  expect(clips.map((c) => c.start).sort((a, b) => a - b)).toEqual([965, 5 * PPQ]);
  expect(await steps()).toBe(n0 + 1);
});
