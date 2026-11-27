/**
 * Audio-node behaviour that needs a real Web Audio implementation: rendered
 * offline (OfflineAudioContext) through the app's own classes, read back
 * sample by sample.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ timeout: 60_000 });

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
}

/**
 * Audio clip fades: a 3 s clip of constant level 1 with a 1 s fade-in and a
 * 1 s fade-out, played through a TrackChannel. Wherever playback starts or
 * stops, the level must follow the clip's own envelope (only a few ms of
 * de-click at a cut), never jump to full level.
 */
test('audio clip fades hold when playback starts mid-clip, stops mid-fade or ends at a loop boundary', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { TrackChannel } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const SR = 48000;
    const track = { id: 't1', kind: 'audio', name: 'A', color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, effects: [], automation: [], modulations: [], sends: [0, 0], instrument: null };
    const render = async (fn: (ch: any, buf: AudioBuffer) => void, secs: number) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(secs * SR), sampleRate: SR });
      const dc = new AudioBuffer({ length: 4 * SR, numberOfChannels: 1, sampleRate: SR });
      dc.getChannelData(0).fill(1);
      const ch = new TrackChannel(ctx, track, ctx.destination, false);
      ch.update(track, true, true);
      fn(ch, dc);
      const out = (await ctx.startRendering()).getChannelData(0);
      // (undo the equal-power pan of a mono source)
      return (t: number) => (out[Math.round(t * SR)] as number) / Math.SQRT1_2;
    };
    const clip = { gain: 1, loop: null, fadeIn: 1, fadeOut: 1, clipDuration: 3 };
    // from the start: the reference envelope
    const full = await render((ch, buf) => ch.playAudio({ ...clip, buffer: buf, when: 0, stopAt: 3, sourcePos: 0, clipOffset: 0 }), 3.1);
    // starting 0.5 s in (seek / play from mid-clip / any edit while playing reschedules like this)
    const midIn = await render((ch, buf) => ch.playAudio({ ...clip, buffer: buf, when: 0, stopAt: 2.5, sourcePos: 0.5, clipOffset: 0.5 }), 2.6);
    // starting 2.5 s in: half-way through the fade-out
    const midOut = await render((ch, buf) => ch.playAudio({ ...clip, buffer: buf, when: 0, stopAt: 0.5, sourcePos: 2.5, clipOffset: 2.5 }), 0.6);
    // the loop region ends at 1.6 s, inside the clip: playback stops there (not the clip's end)
    const loopEnd = await render((ch, buf) => ch.playAudio({ ...clip, buffer: buf, when: 0, stopAt: 1.6, sourcePos: 0, clipOffset: 0 }), 1.7);
    // Stop pressed at 2.5 s, half-way through the fade-out
    const stopped = await render((ch, buf) => {
      ch.playAudio({ ...clip, buffer: buf, when: 0, stopAt: 3, sourcePos: 0, clipOffset: 0 });
      ch.stopSources(2.5);
    }, 3);
    return {
      full: [0.3, 0.6, 1.5, 2.4, 2.7].map(full),
      midIn: [0.1, 0.4].map(midIn), // clip time 0.6 / 0.9
      midOut: [0.1, 0.2].map(midOut), // clip time 2.6 / 2.7
      loopEnd: [1.4, 1.59].map(loopEnd), // well before the clip's fade-out: full level until the last few ms
      stopped: [2.2, 2.45, 2.5, 2.52].map(stopped),
    };
  });
  const near = (a: number[], b: number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - (b[i] as number)), `${a} vs ${b}`).toBeLessThan(tol));
  near(r.full, [0.3, 0.6, 1, 0.6, 0.3], 0.01);
  near(r.midIn, [0.6, 0.9], 0.02);
  near(r.midOut, [0.4, 0.3], 0.02);
  near(r.loopEnd, [1, 1], 0.02);
  // stopping during the fade-out continues down from where the fade was (never back up to full level)
  near(r.stopped.slice(0, 3), [0.8, 0.55, 0.5], 0.02);
  expect(r.stopped[3]).toBeLessThan(0.01);
});
