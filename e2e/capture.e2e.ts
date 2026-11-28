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
  // CAPTURE_CPU_THROTTLE=6: a slow, busy machine (Chromium's CPU throttling), to check the timing holds up
  const slow = Number(process.env.CAPTURE_CPU_THROTTLE ?? 0);
  if (slow > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: slow });
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
    // measure every key as it happens: when it went down / up (`at`, the event's own timestamp) and, while
    // playing, the audio-clock time that was at the speakers then — from the browser's own correlation of the
    // two clocks (getOutputTimestamp: what's heard at a performance.now() time), else the clock less the
    // output latency (`heard`)
    const w = window as unknown as { __live: Live[]; __phasr: Phasr };
    w.__live = [];
    const ids = new Map<number, number>();
    w.__phasr.engine.onLiveInput((e: { type: string; id: number; note?: number; at: number; audition?: boolean }) => {
      if (e.audition || (e.type !== 'noteOn' && e.type !== 'noteOff')) return;
      const { ctx, transport } = w.__phasr.engine;
      if (e.type === 'noteOn') ids.set(e.id, e.note as number);
      const out = ctx.getOutputTimestamp?.();
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const clock = out && out.performanceTime > 0 ? out.contextTime + (e.at - out.performanceTime) / 1000 : ctx.currentTime - (performance.now() - e.at) / 1000 - lat;
      const playing = transport.isPlaying();
      // (and the musical position the transport was playing at that moment: its own tick mapping, which
      // follows it if a slow page made the scheduler skip ahead)
      w.__live.push({ type: e.type, note: ids.get(e.id) as number, id: e.id, at: e.at, heard: playing ? clock : null, tick: playing ? transport.tickAtContextTime(clock) : null });
    });
    return t.id as string;
  }, [BAR, loop] as const);
}

/** a measured key event (see setup) */
interface Live {
  type: 'noteOn' | 'noteOff';
  note: number;
  id: number;
  /** performance.now() of the key event */
  at: number;
  /** the audio-clock time at the speakers when the key went down / up; null when stopped */
  heard: number | null;
  /** the transport's position (wrapped into the loop) at that audio-clock time; null when stopped */
  tick: number | null;
}

const liveEvents = (page: Page): Promise<Live[]> => page.evaluate(() => (window as unknown as { __live: Live[] }).__live);

/** the measured notes: each key's press and release */
function pairs(live: Live[]): { pitch: number; on: Live; off: Live }[] {
  return live.filter((e) => e.type === 'noteOn').map((on) => ({ pitch: on.note, on, off: live.find((e) => e.type === 'noteOff' && e.id === on.id)! }));
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
  // the timing kept: each note where its key went down after the first, as long as it was held (120 BPM:
  // 1.92 ticks per ms) — measured from the actual key events, whenever the browser got to them
  const keys = pairs(await liveEvents(page));
  expect(keys.map((k) => k.pitch)).toEqual([60, 62, 64, 65]);
  const ticks = (ms: number) => (ms * 960 * 2) / 1000;
  cap.notes.forEach((n, i) => {
    expect(Math.abs(n.start - ticks(keys[i]!.on.at - keys[0]!.on.at)), `start ${i}`).toBeLessThanOrEqual(1);
    expect(Math.abs(n.length - ticks(keys[i]!.off.at - keys[i]!.on.at)), `length ${i}`).toBeLessThanOrEqual(1);
  });
  // (and they were played at the intended pace, give or take the browser)
  expect(keys[3]!.on.at - keys[0]!.on.at).toBeGreaterThan(600);
  // one undo step removes it
  await page.keyboard.press('Control+z');
  expect((await clipsOf(page, trackId)).map((c) => c.name)).toEqual(['Old']);
});

test('playing over a loop: notes land where they were heard, passes merged; the popover extends it bar by bar with a preview', async ({ page }) => {
  await openApp(page);
  const trackId = await setup(page, true);
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.transport.play({ fromTick: 0 }));
  // the audio-clock time of tick 0: the keys go down at musical positions (the audio clock keeps time even
  // when the page is slow), and everything below is checked against when they really went down and up
  const t0: number = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const { engine } = (window as unknown as { __phasr: Phasr }).__phasr;
        const f = () => (engine.transport.getTick() > 0 ? resolve(engine.ctx.currentTime - engine.transport.getTick() / 1920) : requestAnimationFrame(f));
        f();
      }),
  );
  const at = (sec: number) => page.waitForFunction((t) => (window as unknown as { __phasr: Phasr }).__phasr.engine.ctx.currentTime >= t, t0 + sec, { polling: 4 });
  // 10 notes, 500 ms apart from 0.3 s, held 150 ms: 5 s over the 4 s loop (two passes). The 8th (C5) goes
  // down 0.55 s before the loop end and up 0.35 s after it: held across the loop end.
  const keys = ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'q', 'w', 'e'];
  const actions = keys.flatMap((k, i) => {
    const on = i === 7 ? 3.45 : 0.3 + 0.5 * i;
    return [{ t: on, k, down: true }, { t: i === 7 ? 4.35 : on + 0.15, k, down: false }];
  });
  actions.sort((a, b) => a.t - b.t);
  for (const a of actions) {
    await at(a.t);
    if (a.down) await page.keyboard.down(a.k);
    else await page.keyboard.up(a.k);
  }
  const live = await liveEvents(page);
  const played = pairs(live);
  expect(played.map((p) => p.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 74, 76]);
  const LOOP = 2 * BAR;
  // roughly where a key event was heard, not wrapped by the loop (120 BPM: 1920 ticks per second from tick 0)
  const tick = (e: Live) => (e.heard! - t0) * 1920;
  // the held note really was held across the loop end (heard down before it, up after it)
  const c5 = played[7]!;
  expect(tick(c5.on), 'C5 went down before the loop end').toBeLessThan(LOOP - 200);
  expect(tick(c5.off), 'C5 came up after the loop end').toBeGreaterThan(LOOP + 200);

  // the popover: a capture is the last N bars up to the last key event (no key is held now). The previews
  // must count exactly the notes whose keys went down in that window, as measured.
  const lastAt = Math.max(...live.map((e) => e.at));
  const inBars = (bars: number) => played.filter((p) => p.on.at >= lastAt - bars * 2000).length;
  expect(inBars(4), 'all ten keys within 4 bars of the last').toBe(10);
  // (open it a while after the last key: a window that ended "now" instead would hold fewer notes)
  await page.waitForFunction((t) => performance.now() >= t, lastAt + 1200);
  await page.getByTestId('capture-settings').click();
  const panel = page.getByTestId('capture-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('capture-bars')).toHaveText('1 bar');
  await expect(page.getByTestId('capture-preview')).toContainText(new RegExp(`^${inBars(1)} notes? `));
  expect(inBars(1)).toBeLessThan(10);
  for (const [n, label] of [[2, '2 bars'], [3, '3 bars'], [4, '4 bars']] as const) {
    await panel.getByRole('button', { name: '+' }).click();
    await expect(page.getByTestId('capture-bars')).toHaveText(label);
    await expect(page.getByTestId('capture-preview')).toContainText(new RegExp(`^${inBars(n)} notes? `));
  }
  await expect(page.getByTestId('capture-preview')).toContainText('where you played them');
  await panel.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(page.getByText(/Captured 10 notes into "Lead capture 1"/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { __phasr: Phasr }).__phasr.engine.transport.stop());

  const cap = (await clipsOf(page, trackId)).find((c) => c.name === 'Lead capture 1')!;
  // merged into the loop: one pass, bars 1–2
  expect([cap.start, cap.length]).toEqual([0, LOOP]);
  expect(cap.notes.map((n) => n.pitch).sort((a, b) => a - b)).toEqual(played.map((p) => p.pitch));
  // each note where it was heard going down, for as long as it was heard held: the measured key times at
  // the speakers, through the transport's position then — within 3 ticks (1.6 ms at 120 BPM; ticks are
  // whole numbers). (Using the playhead when the key is handled instead is 30–40 ms late: the output latency.)
  const TOL = 3;
  for (const p of played) {
    const n = cap.notes.find((x) => x.pitch === p.pitch)!;
    let d = Math.abs(n.start - p.on.tick!);
    d = Math.min(d, LOOP - d);
    expect(d, `note ${p.pitch}: at ${n.start}, heard going down at ${p.on.tick!.toFixed(0)}`).toBeLessThanOrEqual(TOL);
    if (p !== c5) expect(Math.abs(n.length - (p.off.tick! - p.on.tick!)), `note ${p.pitch} length`).toBeLessThanOrEqual(TOL);
  }
  // the note held over the loop end is cut there (as a recording with the loop on does), not left a stub:
  // it lasts from where it went down to the loop end
  const held = cap.notes.find((x) => x.pitch === 72)!;
  if (process.env.CAPTURE_CPU_THROTTLE) {
    const dev = played.map((p) => {
      const d = Math.abs(cap.notes.find((x) => x.pitch === p.pitch)!.start - p.on.tick!);
      return Math.min(d, LOOP - d);
    });
    console.log(`capture: worst start deviation ${Math.max(...dev).toFixed(1)} ticks; C5 heard down at ${tick(c5.on).toFixed(0)}, up at ${tick(c5.off).toFixed(0)}`);
  }
  expect(held.start + held.length).toBe(LOOP);
  expect(Math.abs(held.length - (LOOP - c5.on.tick!))).toBeLessThanOrEqual(TOL);
});
