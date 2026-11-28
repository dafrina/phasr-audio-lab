/**
 * Listening previews of the factory drum kits (not a test: runs only with
 * DRUM_PREVIEWS=<label>, e.g. `DRUM_PREVIEWS=new npx playwright test e2e/drum-previews.e2e.ts`).
 *
 * For every kit: 8 bars of a beat in the kit's style (kick, snare, clap, closed and open
 * hats with chokes, a tom fill, crash, percussion), then every pad once, rendered by the
 * export path at 48 kHz and encoded as a 320 kbps MP3 into previews/drums/<kit>-<label>.mp3.
 * Peak and integrated loudness (BS.1770, K-weighted) of each render go to
 * previews/drums/stats-<label>.json. With DRUM_PREVIEWS_MATCH=<other label>, each render is
 * also written gain-matched to that label's loudness (<kit>-<label>-matched.mp3), for an A/B
 * where the louder one doesn't win by being louder.
 */
import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LABEL = process.env.DRUM_PREVIEWS;
const OUT = fileURLToPath(new URL('../previews/drums/', import.meta.url));
const MATCH: Record<string, { lufs: number }> = process.env.DRUM_PREVIEWS_MATCH ? JSON.parse(readFileSync(`${OUT}stats-${process.env.DRUM_PREVIEWS_MATCH}.json`, 'utf8')) : {};

test.skip(!LABEL, 'listening previews: set DRUM_PREVIEWS=<label> to render them');
test.setTimeout(240_000);

test('render the factory kit previews', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
  const results = await page.evaluate(async ({ label, match }) => {
    const load = (u: string) => import(/* @vite-ignore */ u);
    const w = window as unknown as { __phasr: Record<string, any> };
    const { engine, renderProjectToWav } = w.__phasr;
    const { FACTORY_KITS } = await load('/src/drums/kit.ts');
    const { createProject, createTrack, createMidiClip } = await load('/src/project/defaults.ts');
    const { INSTRUMENTS } = await load('/src/instruments/definitions.ts');
    const { encodeMp3 } = await load('/src/audio/mp3.ts');
    const PPQ = 960;
    const S16 = PPQ / 4;
    const BAR = PPQ * 4;
    const tempo: Record<string, number> = { 'Electro Kit': 120, 'Punchy Kit': 100, 'Lo-Fi Kit': 82, 'House Kit': 124, 'Techno Kit': 132, 'Hip-Hop Kit': 90, 'Trap Kit': 140 };

    // BS.1770 integrated loudness at 48 kHz (K-weighting, 400 ms blocks, 75 % overlap, gates −70 LUFS / −10 LU)
    function lufs(chans: Float32Array[]): number {
      const sos = [
        [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
        [1, -2, 1, -1.99004745483398, 0.99007225036621],
      ];
      const k = chans.map((c) => {
        let x = Float64Array.from(c);
        for (const [b0, b1, b2, a1, a2] of sos) {
          const y = new Float64Array(x.length);
          let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
          for (let i = 0; i < x.length; i++) {
            const v = b0! * x[i]! + b1! * x1 + b2! * x2 - a1! * y1 - a2! * y2;
            x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
          }
          x = y;
        }
        return x;
      });
      const blk = 19200, hop = 4800, blocks: number[] = [];
      for (let s = 0; s + blk <= k[0]!.length; s += hop) {
        let z = 0;
        for (const c of k) { let e = 0; for (let i = s; i < s + blk; i++) e += c[i]! ** 2; z += e / blk; }
        blocks.push(z);
      }
      const L = (z: number) => -0.691 + 10 * Math.log10(z);
      const abs = blocks.filter((z) => L(z) > -70);
      const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const gated = abs.filter((z) => L(z) > rel);
      return L(gated.reduce((a, b) => a + b, 0) / gated.length);
    }

    const out: { name: string; mp3: string; matched?: string; peakDb: number; lufs: number; seconds: number }[] = [];
    const toB64 = (u: Uint8Array) => {
      let bin = '';
      for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    for (const { name, kit } of FACTORY_KITS) {
      const pads = kit.pads as { name: string; source: { kind: string; voice?: string; tone?: number } }[];
      const idx = (voice: string, nth = 0) => pads.map((p, i) => (p.source.voice === voice ? i : -1)).filter((i) => i >= 0)[nth] ?? -1;
      const kick = idx('kick'), snare = idx('snare'), clap = idx('clap'), ch = idx('hatClosed'), oh = idx('hatOpen');
      const crash = idx('crash'), rim = idx('rim'), perc = idx('perc'), shaker = idx('shaker'), bell = idx('cowbell'), zap = idx('zap');
      const toms = pads.map((p, i) => ({ i, t: p.source.voice === 'tom' ? (p.source.tone ?? 0) : -1 })).filter((x) => x.t >= 0).sort((a, b) => b.t - a.t).map((x) => x.i);
      const notes: { pitch: number; start: number; length: number; velocity: number }[] = [];
      const hit = (pad: number, step: number, vel: number) => { if (pad >= 0) notes.push({ pitch: 36 + pad, start: Math.round(step * S16), length: S16 / 2, velocity: vel }); };
      const style = name.split(' ')[0];
      for (let bar = 0; bar < 8; bar++) {
        const o = bar * 16;
        const fill = bar === 3 || bar === 7;
        if (bar === 0 || bar === 4) hit(crash, o, 100);
        if (style === 'House' || style === 'Techno' || style === 'Electro') {
          for (const s of [0, 4, 8, 12]) hit(kick, o + s, 120);
          hit(style === 'House' ? clap : snare, o + 4, 108);
          hit(style === 'House' ? clap : snare, o + 12, 112);
          if (style !== 'House') { hit(clap, o + 12, 90); }
          for (let s = 0; s < 16; s++) {
            if (s % 4 === 2) hit(oh, o + s, 92);
            else if (style === 'Techno' || s % 2 === 0) hit(ch, o + s, s % 4 === 0 ? 70 : 96);
          }
          if (bar >= 4) { hit(style === 'Techno' ? perc : shaker, o + 3, 80); hit(style === 'Techno' ? perc : shaker, o + 11, 70); hit(rim, o + 7, 85); hit(bell, o + 14, 75); }
        } else if (style === 'Trap') {
          hit(kick, o + 0, 120); hit(kick, o + 7, 105); hit(kick, o + 10, 112);
          hit(snare, o + 8, 115); hit(clap, o + 8, 90);
          for (let s = 0; s < 16; s += 2) hit(ch, o + s, s % 4 === 0 ? 100 : 78);
          if (bar % 2 === 1) for (let r = 0; r < 6; r++) hit(ch, o + 12 + r * (4 / 6), 60 + r * 8); // triplet roll
          hit(oh, o + 14, 90);
          if (bar >= 4) { hit(perc, o + 5, 80); hit(rim, o + 3, 80); hit(bell, o + 11, 70); }
        } else {
          // Punchy / Hip-Hop / Lo-Fi: boom-bap
          hit(kick, o + 0, 122); hit(kick, o + 7, 100); hit(kick, o + 10, 115);
          hit(snare, o + 4, 112); hit(snare, o + 12, 116);
          if (style !== 'Punchy') hit(clap, o + 12, 80);
          for (let s = 0; s < 16; s += 2) hit(ch, o + s, s % 4 === 0 ? 96 : 72);
          hit(oh, o + 6, 80);
          if (bar >= 4) { hit(rim, o + 15, 70); hit(shaker, o + 2, 60); hit(shaker, o + 10, 60); hit(perc, o + 9, 80); }
        }
        if (fill) { toms.forEach((t, k) => { hit(t, o + 12 + k, 105); hit(t, o + 12.5 + k, 85); }); }
      }
      hit(zap, 8 * 16 - 2, 100);
      // then every pad once, a beat apart
      pads.forEach((_, i) => hit(i, 8 * 16 + 4 + i * 4, 110));
      const bpm = tempo[name] ?? 120;
      const p = createProject(`${name} preview`);
      const t = createTrack('instrument', 0, { ...INSTRUMENTS.drumrack.createConfig(), kit: structuredClone(kit), presetName: name });
      t.volumeDb = 0;
      const c = createMidiClip(t.id, 0, 8 * BAR + 18 * PPQ);
      c.notes = notes.map((n, i) => ({ ...n, id: `n${i}` }));
      const project = { ...p, bpm, tracks: [t], clips: { [c.id]: { ...c, trackId: t.id } } };
      const r = await renderProjectToWav(project, engine.assets, { sampleRate: 48000, range: 'song', tail: true, format: 'pcm16' });
      const L = r.audio.left as Float32Array, R = r.audio.right as Float32Array;
      let pk = 0;
      for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]!), Math.abs(R[i]!));
      // loudness of the beat only (the 8 bars), not the pad roll
      const beatEnd = Math.round(((8 * 4 * 60) / bpm) * 48000);
      const mp3: Uint8Array = encodeMp3(L, R, { sampleRate: 48000, kbps: 320, title: `${name} (${label})` });
      const loud = lufs([L.subarray(0, beatEnd), R.subarray(0, beatEnd)]);
      let matched: string | undefined;
      const ref = match[name];
      if (ref) {
        const g = Math.pow(10, (ref.lufs - loud) / 20);
        matched = toB64(encodeMp3(L.map((v) => v * g), R.map((v) => v * g), { sampleRate: 48000, kbps: 320, title: `${name} (${label}, loudness-matched)` }));
      }
      out.push({ name, mp3: toB64(mp3), matched, peakDb: 20 * Math.log10(pk), lufs: loud, seconds: L.length / 48000 });
    }
    return out;
  }, { label: LABEL as string, match: MATCH });
  mkdirSync(OUT, { recursive: true });
  const stats: Record<string, { peakDb: number; lufs: number; seconds: number }> = {};
  for (const r of results) {
    const file = `${r.name.toLowerCase().replace(/ kit$/, '').replace(/[^a-z0-9]+/g, '-')}-${LABEL}.mp3`;
    writeFileSync(OUT + file, Buffer.from(r.mp3, 'base64'));
    if (r.matched) writeFileSync(OUT + file.replace(/\.mp3$/, '-matched.mp3'), Buffer.from(r.matched, 'base64'));
    stats[r.name] = { peakDb: +r.peakDb.toFixed(2), lufs: +r.lufs.toFixed(2), seconds: +r.seconds.toFixed(2) };
  }
  writeFileSync(OUT + `stats-${LABEL}.json`, JSON.stringify(stats, null, 2) + '\n');
  console.log(stats);
});
