/**
 * The octave selector (− C4 + beside every instrument window's on-screen keyboard, or [ ] on the computer
 * keyboard) moves what you play: the computer keys, the on-screen keys, and in the Gucci Slipper-izer the
 * chord pads too (on an iPad the on-screen keys and pads are how you play).
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

/** record the pitches the track's instrument starts */
async function spy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __phasr: Phasr; __played: number[] };
    w.__played = [];
    const tid = w.__phasr.projectStore.getState().project.tracks.at(-1).id;
    const inst = w.__phasr.engine.channels.get(tid).instrument;
    const on = inst.noteOn.bind(inst);
    inst.noteOn = (id: number, p: number, v: number, t: number) => {
      w.__played.push(p);
      return on(id, p, v, t);
    };
  });
}
const played = async (page: Page): Promise<number[]> => {
  const p = await page.evaluate(() => (window as unknown as { __played: number[] }).__played.splice(0));
  return p.sort((a, b) => a - b);
};

test('the octave moves the chords: computer keys, the − / + buttons, and the chord pads', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'TriOsc', exact: true }).click();
  await page.getByTitle(/Gucci Slipper-izer/).last().click();
  await expect(page.getByTestId('chord-pads')).toBeVisible();
  await spy(page);
  const pad = page.getByTestId('chord-pads').getByRole('button').first(); // chord 1, the C key
  const tap = async () => {
    await pad.dispatchEvent('pointerdown', { pointerId: 1, button: 0 });
    await page.waitForTimeout(80);
    await pad.dispatchEvent('pointerup', { pointerId: 1, button: 0 });
    await page.waitForTimeout(80);
    return played(page);
  };
  const key = async (k: string) => {
    await page.keyboard.down(k);
    await page.waitForTimeout(80);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
    return played(page);
  };
  // at C4 the key and the pad play the same chord
  const c4 = await key('z');
  expect(c4.length).toBeGreaterThanOrEqual(3);
  expect(await tap()).toEqual(c4);
  // an octave up with ]: the key and the pad both play it 12 higher
  await key(']');
  const up = c4.map((p) => p + 12);
  expect(await key('z')).toEqual(up);
  expect(await tap()).toEqual(up);
  // two down with the − button: 12 lower than at C4
  await page.getByTitle('Octave down ([)').click();
  await page.getByTitle('Octave down ([)').click();
  expect(await tap()).toEqual(c4.map((p) => p - 12));
});

test('the octave selector moves the on-screen keyboard of every instrument window', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Add a track' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'TriOsc', exact: true }).click();
  await page.getByTitle('Open TriOsc').last().click();
  await spy(page);
  const keys = page.locator('[data-note]');
  await expect(keys.first()).toBeVisible();
  const notes = async () => (await keys.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-note'))))).sort((a, b) => a - b);
  const before = await notes();
  // the key under the same spot plays an octave higher after +, and the keys show the octave they play
  const spot = (await keys.first().boundingBox())!;
  const clickSpot = async () => {
    await page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height * 0.8);
    await page.waitForTimeout(80);
    return played(page);
  };
  const low = await clickSpot();
  await page.getByTitle('Octave up (])').click();
  expect(await notes()).toEqual(before.map((n) => n + 12));
  expect(await clickSpot()).toEqual(low.map((n) => n + 12));
  // up to C7: the keys move with it but stay within MIDI (0–127), still the same number of keys
  await page.getByTitle('Octave up (])').click();
  await page.getByTitle('Octave up (])').click();
  await expect(page.getByTitle(/^Octave: the computer keys/).last()).toHaveText('C7');
  const top = await notes();
  expect(top).toHaveLength(before.length);
  expect(top.at(-1)).toBe(127);
  // ] on the computer keyboard does the same; [ back down
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  expect(await notes()).toEqual(before);
});
