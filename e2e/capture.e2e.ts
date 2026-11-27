/**
 * Capture in the running app, played on the computer keyboard (real key
 * presses) without recording: with the transport stopped the phrase lands at
 * the next free bar with its timing kept; while playing over a loop the notes
 * land where they were heard, passes merged. Ctrl/Cmd+K, the toolbar popover
 * (extend bar by bar, preview), one undo step, a toast; editor auditions are
 * not captured.
 */
import { expect, test, type Page } from '@playwright/test';

type Phasr = Record<string, any>;
const PPQ = 960;
const BAR = 4 * PPQ;

async function openApp(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => {
    const p = (window as unknown as { __phasr?: Phasr }).__phasr;
    return p?.engine?.status === 'ready' && p.session?.usePersistStore.getState().status !== 'starting';
  });
}

/** a TriOsc track "Lead" (selected, so the computer keys play it) with a clip over bars 1–2 */
async function setup(page: Page, loop: boolean): Promise<string> {
  return page.evaluate(async ([BAR, loop]) => {
    const { projectStore, uiStore } = (window as unknown as { __phasr: Phasr }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createProject, createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const defs = await load('/src/instruments/definitions.ts');
    const p = createProject('Capture test');
    p.bpm = 120;
    const t = createTrack('instrument', 0, defs.INSTRUMENTS.triosc.createConfig());
    t.name = 'Lead';
    const c = createMidiClip(t.id, 0, 2 * BAR);
    c.name = 'Old';
    projectStore.getState().loadProject({ ...p, tracks: [t], clips: { [c.id]: c }, loop: { enabled: loop, start: 0, end: 2 * BAR } });
    uiStore.getState().set({ selectedTrackId: t.id, selectedClipIds: [] });
    // remember, for each note played, where the transport's playhead was (the test's reference for "where it
    // was played"; Capture itself uses the heard position, which trails it by the output latency)
    const w = window as unknown as { __presses: { at: number; tick: number }[]; __phasr: Phasr };
    w.__presses = [];
    w.__phasr.engine.onLiveInput((e: { type: string; at: number; audition?: boolean }) => {
      if (e.type === 'noteOn' && !e.audition) w.__presses.push({ at: e.at, tick: w.__phasr.engine.transport.getTick() });
    });
    return t.id as string;
  }, [BAR, loop] as const);
}

/** play keys (z = C4 …) at a steady pace: hold `holdMs` (one number, or one per key), `gapMs` from press to press */
async function playKeys(page: Page, keys: string[], gapMs: number, holdMs: number | number[]): Promise<void> {
  for (const [i, k] of keys.entries()) {
    const hold = typeof holdMs === 'number' ? holdMs : (holdMs[i] as number);
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(Math.max(0, gapMs - hold));
  }
}

const clipsOf = (page: Page, trackId: string): Promise<{ id: string; name: string; start: number; length: number; notes: { pitch: number; start: number; length: number }[] }[]> =>
  page.evaluate((id) => {
    const p = (window as unknown as { __phasr: Phasr }).__phasr.projectStore.getState().project;
    return Object.values(p.clips).filter((c: any) => c.trackId === id) as any;
  }, trackId);

test('transport stopped: the phrase lands at the next free bar with its timing kept; one undo; auditions skipped', async ({ page }) => {
  await openApp(page);
  const trackId = await setup(page, false);
  // an editor audition (placing a note) is not playing
  await page.evaluate((id) => (window as unknown as { __phasr: Phasr }).__phasr.engine.previewNoteOn(id, 71, 0.8, performance.now(), true), trackId);
  await playKeys(page, ['z', 'x', 'c', 'v'], 250, 120); // C D E F, eighths at 120 BPM
  await page.keyboard.press('Control+k');
  await expect(page.getByText(/Captured 4 notes into "Lead capture 1"/)).toBeVisible();
  const clips = await clipsOf(page, trackId);
  const cap = clips.find((c) => c.name === 'Lead capture 1')!;
  // the playhead is at bar 1, where "Old" is: the next free bar is 3
  expect(cap.start).toBe(2 * BAR);
  expect(cap.length).toBe(BAR);
  expect(cap.notes.map((n) => n.pitch)).toEqual([60, 62, 64, 65]);
  expect(cap.notes[0]!.start).toBe(0);
  // 250 ms apart = 480 ticks; 120 ms held ≈ 230 ticks (key timing in the browser: ±40 ms)
  cap.notes.slice(1).forEach((n, i) => expect(Math.abs(n.start - cap.notes[i]!.start - 480), `gap ${i}`).toBeLessThan(80));
  for (const n of cap.notes) expect(Math.abs(n.length - 230)).toBeLessThan(80);
  // one undo step removes it
  await page.keyboard.press('Control+z');
  expect((await clipsOf(page, trackId)).map((c) => c.name)).toEqual(['Old']);
});

test('playing over a loop: notes land where they were heard, passes merged; the popover extends it bar by bar with a preview', async ({ page }) => {
  await openApp(page);
  const trackId = await setup(page, true);
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.transport.play({ fromTick: 0 }));
  await page.waitForTimeout(300);
  // 10 notes, 500 ms apart: 5 s over a 4 s loop (two passes); the 8th (C5, at ≈ 3.8 s) is held across the loop end
  await playKeys(page, ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'q', 'w', 'e'], 500, [150, 150, 150, 150, 150, 150, 150, 450, 150, 150]);
  const presses: { at: number; tick: number }[] = await page.evaluate(() => (window as unknown as { __presses: { at: number; tick: number }[] }).__presses);
  expect(presses).toHaveLength(10);

  // the popover: 1 bar (2 s) holds the last 4 notes; three bars reach all ten
  await page.getByTestId('capture-settings').click();
  const panel = page.getByTestId('capture-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('capture-bars')).toHaveText('1 bar');
  await expect(page.getByTestId('capture-preview')).toContainText(/^[34] notes/);
  await panel.getByRole('button', { name: '+' }).click();
  await panel.getByRole('button', { name: '+' }).click();
  await expect(page.getByTestId('capture-bars')).toHaveText('3 bars');
  await expect(page.getByTestId('capture-preview')).toContainText('10 notes');
  await expect(page.getByTestId('capture-preview')).toContainText('where you played them');
  await panel.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(page.getByText(/Captured 10 notes into "Lead capture 1"/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.transport.stop());

  const cap = (await clipsOf(page, trackId)).find((c) => c.name === 'Lead capture 1')!;
  // merged into the loop: one pass, bars 1–2
  expect([cap.start, cap.length]).toEqual([0, 2 * BAR]);
  expect(cap.notes).toHaveLength(10);
  const pitches = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76];
  expect(cap.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual(pitches);
  // each note where the transport was when its key went down (wrapped into the loop); the
  // heard position trails the scheduler's by the output latency, plus key timing jitter
  for (const [i, pitch] of pitches.entries()) {
    const n = cap.notes.find((x) => x.pitch === pitch)!;
    const expected = (((presses[i]!.tick % (2 * BAR)) + 2 * BAR) % (2 * BAR));
    let d = Math.abs(n.start - expected);
    d = Math.min(d, 2 * BAR - d);
    expect(d, `note ${pitch}: at ${n.start}, key went down at ${expected}`).toBeLessThan(200);
  }
  // the note held over the loop end is cut there (as a recording with the loop on does), not left a stub
  const held = cap.notes.find((x) => x.pitch === 72)!;
  expect(held.start + held.length).toBe(2 * BAR);
  expect(held.length).toBeGreaterThan(200);
});
