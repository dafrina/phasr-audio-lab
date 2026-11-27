/**
 * Audio recording through the real recorder (getUserMedia → worklet → clip),
 * with Chromium's fake microphone (a test tone, no permission prompt):
 *
 *  - a normal take becomes an audio clip of about the recorded length, with
 *    finite, non-silent audio, and the input is released afterwards
 *  - the input disappearing mid-take (device unplugged / permission revoked)
 *    keeps what was captured so far and closes the input
 *  - permission denied, or no input device at all: a clear error, no clip,
 *    no crash, and the app keeps working
 */
import { expect, test, type Page } from '@playwright/test';

test.use({
  launchOptions: {
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  },
});

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
  // one empty audio track, no count-in (so the take starts right away)
  await page.evaluate(async () => {
    const { projectStore } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createTrack } = await load('/src/project/defaults.ts');
    const t = createTrack('audio', 0);
    t.id = 'rec';
    projectStore.getState().commit('test setup', (p: any) => ({ ...p, countInBars: 0, tracks: [t], clips: {}, loop: { ...p.loop, enabled: false } }));
  });
}

/** arm the track, record for `ms`, optionally do something mid-take, then stop (unless the take ended on its own) */
async function record(page: Page, ms: number, midTake?: 'lose-input') {
  return page.evaluate(
    async ({ ms, midTake }) => {
      const { recorder, recordingStore, projectStore, engine } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
      const wait = (t: number) => new Promise((r) => setTimeout(r, t));
      await recorder.toggleArm('rec');
      const armed = { status: recordingStore.getState().status, error: recordingStore.getState().error };
      await recorder.start();
      const started = recordingStore.getState().status;
      await wait(ms / 2);
      if (midTake === 'lose-input') {
        // what the browser does when the device goes away: the track ends and fires 'ended'
        // (MediaStreamTrack.stop() alone doesn't fire it, so the event is dispatched as well)
        const track = (recorder as any).input.stream.getAudioTracks()[0] as MediaStreamTrack;
        track.stop();
        track.dispatchEvent(new Event('ended'));
        await wait(1800);
      } else {
        await wait(ms / 2);
        await recorder.stop();
      }
      engine.transport?.stop?.();
      await wait(100);
      const p = projectStore.getState().project;
      const clips = Object.values(p.clips).filter((c: any) => c.trackId === 'rec') as any[];
      const out = clips.map((c) => {
        const buf = engine.assets.get(c.assetId)?.buffer as AudioBuffer | undefined;
        let finite = true;
        let peak = 0;
        if (buf) for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const v of buf.getChannelData(ch)) {
          if (!Number.isFinite(v)) finite = false;
          peak = Math.max(peak, Math.abs(v));
        }
        return { seconds: buf?.duration ?? -1, finite, peak, hasAsset: !!p.assets[c.assetId] };
      });
      return { armed, started, clips: out, status: recordingStore.getState().status, error: recordingStore.getState().error, inputOpen: recorder.isInputOpen() };
    },
    { ms, midTake },
  );
}

test('a normal take becomes a clip of the recorded length with real audio', async ({ page }) => {
  await boot(page);
  const r = await record(page, 2000);
  expect(r.armed.error).toBeNull();
  expect(r.armed.status).toBe('ready');
  expect(r.started).toBe('recording');
  expect(r.clips).toHaveLength(1);
  const c = r.clips[0]!;
  expect(c.hasAsset).toBe(true);
  expect(c.finite).toBe(true);
  // the fake microphone plays a beep: the take is not silent
  expect(c.peak).toBeGreaterThan(0.01);
  // about the 2 s that were recorded (timers and the stop handshake add a little)
  expect(c.seconds).toBeGreaterThan(1.7);
  expect(c.seconds).toBeLessThan(2.6);
  expect(r.status).toBe('ready');
  expect(r.error).toBeNull();
  // disarming releases the microphone
  const closed = await page.evaluate(async () => {
    const { recorder } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    await recorder.toggleArm('rec');
    return recorder.isInputOpen();
  });
  expect(closed).toBe(false);
});

test('the input disappearing mid-take keeps what was captured and closes the input', async ({ page }) => {
  await boot(page);
  const r = await record(page, 2000, 'lose-input');
  expect(r.started).toBe('recording');
  // the first second was captured before the input went away
  expect(r.clips).toHaveLength(1);
  expect(r.clips[0]!.finite).toBe(true);
  expect(r.clips[0]!.seconds).toBeGreaterThan(0.7);
  expect(r.clips[0]!.seconds).toBeLessThan(1.6);
  expect(r.error).toMatch(/input stopped/);
  expect(r.inputOpen).toBe(false);
  expect(r.status).toBe('idle');
});

for (const [name, message] of [
  ['NotAllowedError', /denied/],
  ['NotFoundError', /No audio input device/],
] as const) {
  test(`getUserMedia failing with ${name}: a clear error, no clip, the app keeps working`, async ({ page }) => {
    await page.addInitScript((n) => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('test', n));
    }, name);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page);
    const r = await record(page, 600);
    expect(r.armed.error).toMatch(message);
    expect(r.clips).toHaveLength(0);
    expect(r.inputOpen).toBe(false);
    expect(r.status).toBe('idle');
    // a toast says so
    await expect(page.getByText(message).first()).toBeVisible();
    // no uncaught exception, and playback still works
    expect(errors).toEqual([]);
    const playing = await page.evaluate(async () => {
      const { engine } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
      engine.transport.play({ fromTick: 0 });
      await new Promise((r) => setTimeout(r, 300));
      const s = engine.transport.isPlaying();
      engine.transport.stop();
      return s;
    });
    expect(playing).toBe(true);
  });
}

test('MIDI recording started mid-loop keeps a later pass’s notes where they were played', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
  const r = await page.evaluate(async () => {
    const { projectStore, recorder, engine } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { createTrack } = await load('/src/project/defaults.ts');
    const t = createTrack('instrument', 0);
    t.id = 'm';
    // 240 BPM: a bar is 1 s; loop bars 1–2, record from bar 2 (mid-loop)
    projectStore.getState().commit('test setup', (p: any) => ({ ...p, bpm: 240, countInBars: 0, tracks: [t], clips: {}, loop: { enabled: true, start: 0, end: 7680 } }));
    await new Promise((r) => setTimeout(r, 200));
    engine.transport.seek(3840);
    const startedAt = Math.round(engine.transport.getTick());
    await recorder.toggleArm('m');
    await recorder.start();
    const until = (ok: () => boolean) =>
      new Promise<void>((res) => {
        const f = () => (ok() ? res() : setTimeout(f, 5));
        f();
      });
    // one note in bar 2 (first pass), then wait for the wrap and play one in bar 1 (second pass)
    await until(() => engine.transport.getTick() > 4300);
    const a = engine.previewNoteOn('m', 60, 0.8);
    await new Promise((r) => setTimeout(r, 150));
    engine.previewNoteOff('m', a);
    await until(() => engine.transport.getTick() > 400 && engine.transport.getTick() < 3000);
    const heardAt = Math.round(engine.transport.getTick());
    const b = engine.previewNoteOn('m', 64, 0.8);
    await new Promise((r) => setTimeout(r, 150));
    engine.previewNoteOff('m', b);
    await new Promise((r) => setTimeout(r, 100));
    await recorder.stop();
    engine.transport.stop();
    const clip = Object.values(projectStore.getState().project.clips).find((c: any) => c.trackId === 'm') as any;
    return { startedAt, heardAt, clipStart: clip?.start, notes: clip?.notes.map((n: any) => ({ pitch: n.pitch, at: clip.start + n.start, length: n.length })) };
  });
  expect(r.startedAt).toBe(3840);
  const second = r.notes.find((n: { pitch: number }) => n.pitch === 64);
  expect(second, JSON.stringify(r)).toBeDefined();
  // where it was played (within ~120 ms of output latency = 480 ticks at 240 BPM), not pulled to bar 2
  expect(second.at).toBeLessThan(3840);
  expect(Math.abs(second.at - r.heardAt)).toBeLessThan(480);
  // 150 ms held = 600 ticks at 240 BPM (± scheduling jitter), not stretched to the loop end
  expect(second.length).toBeGreaterThan(300);
  expect(second.length).toBeLessThan(1000);
  expect(r.notes.find((n: { pitch: number }) => n.pitch === 60).at).toBeGreaterThanOrEqual(3840);
});
