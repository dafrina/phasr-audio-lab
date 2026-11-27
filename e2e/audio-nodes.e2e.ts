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

/**
 * A volume lane removed (or switched off) while playing: the fader goes back
 * to its own value. (It used to freeze part-way between the lane's value and
 * the fader's, until the track was edited again.)
 */
test('removing a volume automation lane during playback returns the fader to its own level', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { engine, projectStore } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    await engine.ctx.resume();
    const st = projectStore.getState();
    const id = st.project.tracks[1].id;
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    // fader at 0 dB, lane at −60 dB
    st.commit('lane', (p: any) => ({
      ...p,
      loop: { ...p.loop, enabled: false },
      tracks: p.tracks.map((t: any) => (t.id === id ? { ...t, volumeDb: 0, automation: [{ id: 'L', enabled: true, target: { kind: 'track', param: 'volumeDb' }, points: [{ id: 'a', tick: 0, value: -60 }] }] } : t)),
    }));
    engine.transport.seek(0);
    engine.transport.play();
    await wait(400);
    const gain = () => engine.channels.get(id).volume.gain.value as number;
    const during = gain();
    // the lane is deleted while playing
    projectStore.getState().commit('delete lane', (p: any) => ({ ...p, tracks: p.tracks.map((t: any) => (t.id === id ? { ...t, automation: [] } : t)) }));
    await wait(500);
    const after = gain();
    // and a lane switched off behaves the same
    projectStore.getState().commit('lane', (p: any) => ({ ...p, tracks: p.tracks.map((t: any) => (t.id === id ? { ...t, automation: [{ id: 'L', enabled: true, target: { kind: 'track', param: 'volumeDb' }, points: [{ id: 'a', tick: 0, value: -60 }] }] } : t)) }));
    await wait(400);
    const again = gain();
    projectStore.getState().commit('off', (p: any) => ({ ...p, tracks: p.tracks.map((t: any) => (t.id === id ? { ...t, automation: t.automation.map((l: any) => ({ ...l, enabled: false })) } : t)) }));
    await wait(500);
    const off = gain();
    engine.transport.stop();
    return { during, after, again, off };
  });
  expect(r.during).toBeLessThan(0.01);
  expect(r.after).toBeCloseTo(1, 2);
  expect(r.again).toBeLessThan(0.01);
  expect(r.off).toBeCloseTo(1, 2);
});

/**
 * Drum pad sends follow the track fader: also when the fader is automated or
 * ducked by a sidechain (the README: pad sends go "after the pad's EQ, then
 * the track fader and mute"). They used to keep sending at the static level.
 */
test('drum pad sends follow the track volume automation and sidechain ducking', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const { TrackChannel } = (window as unknown as { __phasr: Record<string, any> }).__phasr;
    const load = (u: string): Promise<any> => import(/* @vite-ignore */ u);
    const { DrumRackInstrument } = await load('/src/audio/drumRack.ts');
    const { defaultKit } = await load('/src/drums/kit.ts');
    const SR = 48000;
    const run = async (how: 'plain' | 'automated' | 'ducked') => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(0.3 * SR), sampleRate: SR });
      const dc = new AudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR });
      dc.getChannelData(0).fill(1);
      // left = the track's own output, right = Send A
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      merger.connect(ctx.destination);
      const dry = new GainNode(ctx);
      dry.connect(merger, 0, 0);
      const sendA = new GainNode(ctx);
      sendA.connect(merger, 0, 1);
      const kit = defaultKit();
      kit.pads[0] = { ...kit.pads[0], source: { kind: 'sample', assetId: 'dc' }, gain: 0, pan: 0, sends: [1, 0] };
      const volLane = { id: 'l', target: { kind: 'track', param: 'volumeDb' }, enabled: true, points: [{ id: 'p', tick: 0, value: -60 }] };
      const track = { id: 'd', kind: 'instrument', name: 'Drums', color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, effects: [], modulations: [], sends: [0, 0], automation: how === 'automated' ? [volLane] : [], instrument: { type: 'drumrack', kit, presetName: 'x' } };
      const ch = new TrackChannel(ctx, track, dry, false);
      ch.update(track, true, true);
      ch.setSends(track.sends, [sendA, new GainNode(ctx)], true);
      const rack = new DrumRackInstrument(ctx, kit, (id: string) => (id === 'dc' ? dc : undefined));
      ch.attachInstrument(rack, 'drumrack');
      const vol = { kind: 'track', param: 'volumeDb' };
      // what the transport does for the lane, and a full-depth −60 dB "Duck from" route at its peak
      if (how === 'automated') for (const t of ch.automationParams(vol)) t.param.setValueAtTime(t.map(-60), 0);
      if (how === 'ducked') for (const m of ch.modulationInputs(vol)) m.param.value = 1 + m.scale(-60);
      rack.play(0, 0.01, 1);
      const out = await ctx.startRendering();
      const i = Math.round(0.1 * SR);
      return { dry: Math.abs(out.getChannelData(0)[i] as number), send: Math.abs(out.getChannelData(1)[i] as number) };
    };
    return { plain: await run('plain'), automated: await run('automated'), ducked: await run('ducked') };
  });
  // both paths carry the pad normally …
  expect(r.plain.dry).toBeGreaterThan(0.3);
  expect(r.plain.send).toBeGreaterThan(0.3);
  // … and both fall silent with the fader automated down or ducked
  for (const k of ['automated', 'ducked'] as const) {
    expect(r[k].dry, k).toBeLessThan(0.003);
    expect(r[k].send, k).toBeLessThan(0.003);
  }
});
