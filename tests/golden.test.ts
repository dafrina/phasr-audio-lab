/**
 * The golden reference project (tests/fixtures/golden.ts) through the code
 * paths a user's project takes: save (JSON) / load (migrations + validation),
 * archive export / import, tool expansion, and scheduling — the live
 * transport's many small lookahead windows against the export's single plan.
 */
import { describe, expect, it } from 'vitest';
import { buildGoldenProject, goldenAssets, GOLDEN_BARS, GOLDEN_BPM } from './fixtures/golden';
import { migrateProject } from '../src/project/migrations';
import { buildArchive, parseArchive } from '../src/persistence/archive';
import { withToolsExpanded } from '../src/arp/expand';
import { inOrder, planWindow, type Cursor, type PlanContext } from '../src/audio/scheduling';
import { PPQ, ticksPerBar, ticksPerBeatUnit, ticksToSeconds } from '../src/core/time';
import type { AutomationTarget, Project } from '../src/project/types';

const SONG_TICKS = GOLDEN_BARS * PPQ * 4;
const SONG_SEC = ticksToSeconds(SONG_TICKS, GOLDEN_BPM);

describe('golden project: save / load / archive', () => {
  it('builds through the app factories and passes validation unchanged', () => {
    const p = buildGoldenProject();
    expect(p.tracks).toHaveLength(12);
    // loading = JSON + migrations + sanitizers: nothing may be lost or "repaired"
    const loaded = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(loaded).toEqual(p);
    // and loading is idempotent
    expect(migrateProject(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded);
  });

  it('every subsystem survives the round trip (spot checks of the parts most likely to be dropped)', () => {
    const p = migrateProject(JSON.parse(JSON.stringify(buildGoldenProject())));
    const t = (n: number) => p.tracks.find((x) => x.id === `gold-t${n}`)!;
    expect(t(2).arp?.steps.slice(0, 8).map((s) => [s.on, s.tie, s.prob, s.slide, s.ratchet])).toEqual([
      [true, true, 1, false, 1],
      [true, false, 1, false, 1],
      [false, false, 1, false, 1],
      [true, false, 0.5, false, 1],
      [true, false, 1, true, 1],
      [false, false, 1, false, 1],
      [true, true, 1, false, 1],
      [true, false, 1, false, 2],
    ]);
    expect(t(3).automation.map((l) => l.target)).toEqual<AutomationTarget[]>([
      { kind: 'inst', param: 'filter.cutoff' },
      { kind: 'inst', param: 'filter.resonance' },
      { kind: 'track', param: 'volumeDb' },
    ]);
    expect(t(9).mute).toBe(true);
    expect(t(10).effects.map((e) => e.type)).toEqual(['utility', 'saturator', 'phaser']);
    expect(t(11).modulations.map((m) => [m.source, m.note, m.depth])).toEqual([
      ['midi', 36, -12],
      ['audio', null, 2],
    ]);
    expect(t(7).chords?.enabled).toBe(true);
    expect(p.master.effects.map((e) => e.type)).toEqual(['peq', 'compressor']);
    expect(p.sends.map((s) => s.effects.map((e) => e.type))).toEqual([['reverb'], ['delay']]);
    expect(Object.keys(p.assets).sort()).toEqual(['gold-loop', 'gold-pluck-loud', 'gold-pluck-soft']);
  });

  it('archive export → import keeps the project and every audio byte (with a new project id)', async () => {
    const p = buildGoldenProject();
    const assets = goldenAssets().map((a) => ({ id: a.ref.id, mime: a.mime, bytes: new Uint8Array(a.bytes) }));
    const parsed = await parseArchive(buildArchive(p, assets, new Date(1_700_000_000_000)));
    expect(parsed.missing).toEqual([]);
    expect(parsed.project.id).not.toBe(p.id);
    expect({ ...parsed.project, id: p.id, updatedAt: p.updatedAt, createdAt: p.createdAt }).toEqual(p);
    for (const a of assets) {
      const back = parsed.assets.find((x) => x.id === a.id);
      expect(back, a.id).toBeDefined();
      expect(Buffer.from(back!.bytes).equals(Buffer.from(a.bytes)), a.id).toBe(true);
    }
  });

  it('an archive missing an audio file still opens, and names what is missing', async () => {
    const p = buildGoldenProject();
    const assets = goldenAssets()
      .filter((a) => a.ref.id !== 'gold-loop')
      .map((a) => ({ id: a.ref.id, mime: a.mime, bytes: new Uint8Array(a.bytes) }));
    const parsed = await parseArchive(buildArchive(p, assets));
    expect(parsed.missing).toEqual(['gold-loop']);
    // the clips that use it are kept (the user can relink / re-import)
    expect(Object.values(parsed.project.clips).filter((c) => c.kind === 'audio')).toHaveLength(2);
  });

  it('a truncated or corrupted archive is refused with an error (never half-imported)', async () => {
    const bytes = buildArchive(buildGoldenProject(), goldenAssets().map((a) => ({ id: a.ref.id, mime: a.mime, bytes: new Uint8Array(a.bytes) })));
    await expect(parseArchive(bytes.slice(0, Math.floor(bytes.length / 2)))).rejects.toThrow();
    const bad = bytes.slice();
    for (let i = 200; i < 260; i++) bad[i] = (bad[i] as number) ^ 0xff;
    await expect(parseArchive(bad)).rejects.toThrow();
  });
});

/** the notes each track plays after the Slipper-izer and Arp-Ape-ator, as text (no ids) */
function expandedNotes(p: Project): Record<string, string[]> {
  const e = withToolsExpanded(p);
  const out: Record<string, string[]> = {};
  for (const c of Object.values(e.clips)) {
    if (c.kind !== 'midi') continue;
    const name = e.tracks.find((t) => t.id === c.trackId)!.name;
    (out[name] ??= []).push(...c.notes.map((n) => `${c.start + n.start}:${n.pitch}:${n.length}:${n.velocity}`));
  }
  for (const k of Object.keys(out)) out[k]!.sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
  return out;
}

describe('golden project: what the tools play', () => {
  it('chord and arp expansion is stable (snapshot) and the same every time', () => {
    const a = expandedNotes(buildGoldenProject());
    expect(expandedNotes(buildGoldenProject())).toEqual(a);
    expect(a['808 Seq']!.length).toBeGreaterThan(10);
    expect(a['Chords']!.length).toBeGreaterThan(8);
    expect(a['Arp']!.length).toBeGreaterThan(20);
    expect(a).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// live transport (many lookahead windows) vs export (one plan)
// ---------------------------------------------------------------------------

function planCtx(p: Project, loop: Project['loop']): PlanContext {
  return { bpm: p.bpm, loop, beatTicks: ticksPerBeatUnit(p.timeSignature), barTicks: ticksPerBar(p.timeSignature), metronome: false, tracks: p.tracks, clips: Object.values(p.clips) };
}

interface Heard {
  notes: string[];
  audio: string[];
  /** automation: lane → value at sample times */
  lanes: Map<string, { time: number; value: number }[]>;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function collect(plans: ReturnType<typeof planWindow>[], until: number): Heard {
  const notes: string[] = [];
  const audio: string[] = [];
  const lanes = new Map<string, { time: number; value: number }[]>();
  for (const plan of plans) {
    for (const n of plan.notes) if (n.onTime < until - 1e-9) notes.push(`${n.trackId}:${n.pitch}:${r6(n.onTime)}:${r6(Math.min(n.offTime, until))}:${n.velocity}`);
    for (const a of plan.audio) if (a.when < until - 1e-9) audio.push(`${a.trackId}:${a.clip.id}:${r6(a.when)}:${r6(Math.min(a.stopAt, until))}:${r6(a.sourcePos)}`);
    for (const lane of plan.automation) {
      const key = `${lane.trackId}:${JSON.stringify(lane.target)}`;
      const list = lanes.get(key) ?? [];
      // as the transport schedules them: never before the lane's previous event
      for (const ev of inOrder(lane.events, list.at(-1)?.time ?? -Infinity).events) list.push({ time: ev.time, value: ev.value });
      lanes.set(key, list);
    }
  }
  notes.sort();
  audio.sort();
  return { notes, audio, lanes };
}

/** the value an AudioParam would hold at time t, given set/ramp events (linear ramps; like
 * Web Audio, events are kept in time order and equal times in the order they were added) */
function valueAt(events: { time: number; value: number }[], t: number): number {
  const ev = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.time - b.time || a.i - b.i);
  let prev = ev[0]!;
  for (const e of ev) {
    if (e.time > t) return prev.time === e.time ? e.value : prev.value + ((e.value - prev.value) * (t - prev.time)) / (e.time - prev.time);
    prev = e;
  }
  return prev.value;
}

describe('golden project: live scheduling = export scheduling', () => {
  const p = withToolsExpanded(buildGoldenProject());

  it('the transport’s lookahead windows (25 ms steps, 150 ms ahead) schedule exactly what the export plans', () => {
    // export: one plan over the song, the range end acting as a hard stop
    const exp = collect([planWindow(planCtx(p, { enabled: true, start: 0, end: SONG_TICKS }), { tick: 0, time: 0, fresh: true }, SONG_SEC)], SONG_SEC);
    // live: the transport's windows; no loop, so the song just runs past its end
    const plans = [];
    let cursor: Cursor = { tick: 0, time: 0, fresh: true };
    for (let now = 0; now < SONG_SEC + 0.2; now += 0.025) {
      const plan = planWindow(planCtx(p, { ...p.loop, enabled: false }), cursor, now + 0.15);
      plans.push(plan);
      cursor = plan.next;
    }
    const live = collect(plans, SONG_SEC);
    expect(live.notes.length).toBeGreaterThan(150);
    expect(live.notes).toEqual(exp.notes);
    expect(live.audio).toEqual(exp.audio);
    // automation: the same curve, sampled every 10 ms
    expect([...live.lanes.keys()].sort()).toEqual([...exp.lanes.keys()].sort());
    for (const [key, evs] of exp.lanes) {
      const lv = live.lanes.get(key)!;
      for (let t = 0; t < SONG_SEC; t += 0.01) expect(valueAt(lv, t), `${key} at ${t.toFixed(2)} s`).toBeCloseTo(valueAt(evs, t), 6);
    }
  });

  it('with the loop on, every pass of the loop schedules the same notes — none skipped, none doubled', () => {
    const loop = { enabled: true, start: PPQ * 4, end: PPQ * 12 };
    const passSec = ticksToSeconds(loop.end - loop.start, GOLDEN_BPM);
    const plans = [];
    let cursor: Cursor = { tick: loop.start, time: 0, fresh: true };
    for (let now = 0; now < 3 * passSec; now += 0.025) {
      const plan = planWindow(planCtx(p, loop), cursor, now + 0.15);
      plans.push(plan);
      cursor = plan.next;
    }
    const heard = collect(plans, 3 * passSec);
    const pass = (k: number) =>
      heard.notes
        .map((n) => n.split(':'))
        .filter((f) => Number(f[2]) >= k * passSec - 1e-6 && Number(f[2]) < (k + 1) * passSec - 1e-6)
        .map((f) => `${f[0]}:${f[1]}:${r6(Number(f[2]) - k * passSec)}`)
        .sort();
    expect(pass(0).length).toBeGreaterThan(40);
    expect(pass(1)).toEqual(pass(0));
    expect(pass(2)).toEqual(pass(0));
    // and nothing is scheduled twice
    expect(new Set(heard.notes).size).toBe(heard.notes.length);
  });
});
