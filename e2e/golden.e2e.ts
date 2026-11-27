/**
 * The golden reference project in the real browser engine:
 *  - offline render (the export path) is deterministic: two renders differ by at most
 *    1e-6 (−120 dB). Not bit-exact: Chromium sums a node's many inputs (overlapping
 *    drum hits) in an order that can change between renders, so the last float bit
 *    varies (measured: ~2e-10 on the Drum Rack track; every other track renders
 *    bit-identically on its own)
 *  - a muted track contributes nothing
 *  - save → reload the page → reopen → render gives the same result (10 ms loudness
 *    envelope within 0.001 dB)
 *    (IndexedDB / OPFS, migrations, asset storage and decoding all in the loop)
 *  - the mix matches the committed baseline (length exactly; level and a 100 ms
 *    loudness envelope within measured tolerances), so DSP or routing changes
 *    that alter the sound are caught. `npm run test:e2e:update` rewrites the
 *    baseline after an intended sound change.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE = fileURLToPath(new URL('./golden-baseline.json', import.meta.url));
/** the fixture, as the dev server serves it to the page */
const FIXTURE = '/tests/fixtures/golden.ts';

interface Render {
  frames: number;
  sampleRate: number;
  hash: string;
  finite: boolean;
  peakDb: [number, number];
  rmsDb: [number, number];
  /** RMS per 100 ms window, dB (left + right) */
  envelope: number[];
  /** RMS per 10 ms window, dB: the fine comparison between renders in this run */
  fine: number[];
  /** largest sample difference to the previous render in this page (null: first render here) */
  maxDiffToPrevious: number | null;
}

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
}

/** the largest 10 ms loudness difference between two renders, dB (where either is above −90 dB) */
const fineDiff = (a: Render, b: Render) => Math.max(0, ...a.fine.map((v, i) => (Math.max(v, b.fine[i] ?? -200) > -90 ? Math.abs(v - (b.fine[i] ?? -200)) : 0)));

/** build (or take) the golden project in the page, register its generated audio, render it offline */
async function render(page: Page, opts: { fromStore?: boolean; drop?: string } = {}): Promise<Render> {
  return page.evaluate(async ({ fromStore, drop, GOLDEN }) => {
    const w = window as unknown as { __phasr: Record<string, any> };
    const { engine, projectStore, renderProjectToWav } = w.__phasr;
    const g = await import(GOLDEN);
    let project = fromStore ? projectStore.getState().project : g.buildGoldenProject();
    if (drop) project = { ...project, tracks: project.tracks.filter((t: { id: string }) => t.id !== drop) };
    for (const a of g.goldenAssets()) if (!engine.assets.has(a.ref.id)) await engine.assets.decodeBytes(engine.ctx, a.bytes.slice(0), a.ref.name, a.mime, a.ref.id);
    const r = await renderProjectToWav(project, engine.assets, { sampleRate: 48000, range: 'song', tail: true, format: 'pcm16' });
    const chans: Float32Array[] = [r.audio.left, r.audio.right];
    // FNV-1a over the float bits: bit-exact comparison between renders
    let h = 0x811c9dc5;
    let finite = true;
    const peak = [0, 0];
    const sq = [0, 0];
    chans.forEach((c, k) => {
      const u = new Uint32Array(c.buffer, c.byteOffset, c.length);
      for (let i = 0; i < u.length; i++) {
        h = Math.imul(h ^ (u[i] as number), 16777619) >>> 0;
        const v = c[i] as number;
        if (!Number.isFinite(v)) finite = false;
        const a = Math.abs(v);
        if (a > peak[k]!) peak[k] = a;
        sq[k]! += v * v;
      }
    });
    const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -200);
    const env = (win: number, digits: number) => {
      const out: number[] = [];
      for (let s = 0; s < r.frames; s += win) {
        let e = 0;
        let n = 0;
        for (const c of chans) for (let i = s; i < Math.min(r.frames, s + win); i++, n++) e += (c[i] as number) ** 2;
        out.push(Math.round(db(Math.sqrt(e / Math.max(1, n))) * digits) / digits);
      }
      return out;
    };
    const envelope = env(r.sampleRate / 10, 100);
    const fine = env(r.sampleRate / 100, 10000);
    // compare with the previous render in this page, sample by sample
    const prev = (w as unknown as { __goldPrev?: Float32Array[] }).__goldPrev;
    let maxDiffToPrevious: number | null = null;
    if (prev && prev[0]!.length === chans[0]!.length) {
      maxDiffToPrevious = 0;
      for (let k = 0; k < 2; k++) for (let i = 0; i < chans[k]!.length; i++) maxDiffToPrevious = Math.max(maxDiffToPrevious, Math.abs((chans[k]![i] as number) - (prev[k]![i] as number)));
    }
    (w as unknown as { __goldPrev?: Float32Array[] }).__goldPrev = chans.map((c) => c.slice());
    return {
      frames: r.frames,
      sampleRate: r.sampleRate,
      hash: h.toString(16),
      finite,
      peakDb: [db(peak[0]!), db(peak[1]!)] as [number, number],
      rmsDb: [db(Math.sqrt(sq[0]! / r.frames)), db(Math.sqrt(sq[1]! / r.frames))] as [number, number],
      envelope,
      fine,
      maxDiffToPrevious,
    };
  }, { ...opts, GOLDEN: FIXTURE });
}

test.describe.serial('golden project', () => {
  let first: Render;

  test('renders deterministically, with sound and finite samples', async ({ page }) => {
    await boot(page);
    first = await render(page);
    const again = await render(page);
    expect(first.finite).toBe(true);
    expect(first.rmsDb[0]).toBeGreaterThan(-40);
    expect(first.peakDb[0]).toBeLessThan(0.5);
    expect(again.frames).toBe(first.frames);
    expect(again.maxDiffToPrevious).not.toBeNull();
    expect(again.maxDiffToPrevious!, `renders differ by up to ${again.maxDiffToPrevious}`).toBeLessThan(1e-6);
    test.info().annotations.push({ type: 'determinism', description: `two renders: ${again.hash === first.hash ? 'bit-identical' : `max sample difference ${again.maxDiffToPrevious?.toExponential(2)}`}` });
  });

  test('a muted track contributes nothing', async ({ page }) => {
    await boot(page);
    const without = await render(page, { drop: 'gold-t9' });
    expect(without.frames).toBe(first.frames);
    expect(fineDiff(without, first)).toBeLessThan(0.001);
  });

  test('save → reload → reopen gives the identical render', async ({ page }) => {
    await boot(page);
    await page.evaluate(async (GOLDEN) => {
      const w = window as unknown as { __phasr: Record<string, any> };
      const { engine, projectStore, session } = w.__phasr;
      const g = await import(GOLDEN);
      for (const a of g.goldenAssets()) if (!engine.assets.has(a.ref.id)) await engine.assets.decodeBytes(engine.ctx, a.bytes.slice(0), a.ref.name, a.mime, a.ref.id);
      projectStore.getState().loadProject(g.buildGoldenProject());
      await session.saveNow();
      if (session.usePersistStore?.getState().error) throw new Error(session.usePersistStore.getState().error);
    }, FIXTURE);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __phasr?: { engine?: { status?: string } } }).__phasr?.engine?.status === 'ready');
    const opened = await page.evaluate(async () => {
      const w = window as unknown as { __phasr: Record<string, any> };
      const { session, projectStore, engine } = w.__phasr;
      const ok = await session.openProject('golden-project', { quiet: true });
      // the stored audio is decoded on open; wait for all three assets
      for (let i = 0; i < 100 && !['gold-loop', 'gold-pluck-loud', 'gold-pluck-soft'].every((id) => engine.assets.has(id)); i++) await new Promise((r) => setTimeout(r, 50));
      return { ok, id: projectStore.getState().project.id, tracks: projectStore.getState().project.tracks.length, assets: ['gold-loop', 'gold-pluck-loud', 'gold-pluck-soft'].filter((id) => engine.assets.has(id)) };
    });
    expect(opened).toEqual({ ok: true, id: 'golden-project', tracks: 12, assets: ['gold-loop', 'gold-pluck-loud', 'gold-pluck-soft'] });
    const reopened = await render(page, { fromStore: true });
    expect(reopened.frames).toBe(first.frames);
    expect(fineDiff(reopened, first)).toBeLessThan(0.001);
  });

  test('matches the committed baseline', async () => {
    if (process.env.UPDATE_GOLDEN || !existsSync(BASELINE)) {
      if (process.env.CI && !process.env.UPDATE_GOLDEN) throw new Error('e2e/golden-baseline.json is missing: run `npm run test:e2e:update` and commit it');
      const { fine: _fine, maxDiffToPrevious: _m, hash: _h, ...keep } = first;
      writeFileSync(BASELINE, JSON.stringify({ note: 'Golden project mix (e2e/golden.e2e.ts). Regenerate with `npm run test:e2e:update` only after an intended sound change.', ...keep }) + '\n');
      return;
    }
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Render;
    expect(first.frames).toBe(base.frames);
    expect(first.sampleRate).toBe(base.sampleRate);
    for (const k of [0, 1]) {
      expect(Math.abs(first.peakDb[k]! - base.peakDb[k]!), `peak ch${k}`).toBeLessThan(0.5);
      expect(Math.abs(first.rmsDb[k]! - base.rmsDb[k]!), `rms ch${k}`).toBeLessThan(0.2);
    }
    // where does it diverge? the first 100 ms window that moved by more than 0.5 dB (ignoring near-silence)
    const off = first.envelope.findIndex((v, i) => Math.max(v, base.envelope[i] ?? -200) > -60 && Math.abs(v - (base.envelope[i] ?? -200)) > 0.5);
    expect(off, off >= 0 ? `envelope differs from ${(off / 10).toFixed(1)} s: ${first.envelope[off]} dB vs ${base.envelope[off]} dB` : '').toBe(-1);
  });
});
