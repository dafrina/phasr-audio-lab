/**
 * Pure scheduling math used by the transport. Nothing here touches the Web
 * Audio API so it can be unit tested in Node.
 *
 * The transport keeps a cursor (tick ↔ AudioContext time). Each scheduler
 * pass turns the lookahead window [cursor.time, windowEnd) into one or more
 * linear *segments*. A segment is a contiguous tick range with a fixed
 * time origin; a loop wrap ends one segment and starts a new one at the loop
 * start. Events are collected per segment and timed with `segmentTime()`.
 */
import { secondsToTicks, ticksToSeconds } from '../core/time';
import { warpRate } from './warp';
import type { AudioClip, AutomationLane, AutomationPoint, AutomationTarget, LoopRegion, MidiClip, MidiNote } from '../project/types';
import { valueAt } from '../project/automation';

export interface Cursor {
  tick: number;
  time: number;
  /** True right after play/seek/wrap: clips already in progress must start mid-way */
  fresh: boolean;
}

export interface Segment {
  startTick: number;
  endTick: number;
  startTime: number;
  /** Events must not sound past this tick in this segment (the loop end) */
  hardEndTick: number;
  fresh: boolean;
}

export function segmentTime(seg: Segment, tick: number, bpm: number): number {
  return seg.startTime + ticksToSeconds(tick - seg.startTick, bpm);
}

export function activeLoop(loop: LoopRegion): LoopRegion | null {
  return loop.enabled && loop.end - loop.start >= 1 ? loop : null;
}

/**
 * Split the window from `cursor` to `windowEndTime` into segments, wrapping at
 * the loop end. Returns the segments and the cursor for the next pass.
 */
export function computeSegments(
  cursor: Cursor,
  windowEndTime: number,
  bpm: number,
  loop: LoopRegion,
): { segments: Segment[]; next: Cursor } {
  const segments: Segment[] = [];
  let { tick, time, fresh } = cursor;
  const lp = activeLoop(loop);
  // If the cursor is past the loop end (e.g. loop enabled while playing after
  // the region), playback just continues linearly.
  const looping = lp !== null && tick < lp.end;
  let guard = 0;
  while (time < windowEndTime && guard++ < 64) {
    const ticksAvail = secondsToTicks(windowEndTime - time, bpm);
    let endTick = tick + ticksAvail;
    if (looping && lp && endTick >= lp.end) {
      endTick = lp.end;
      segments.push({ startTick: tick, endTick, startTime: time, hardEndTick: lp.end, fresh });
      time += ticksToSeconds(lp.end - tick, bpm);
      tick = lp.start;
      fresh = true;
      continue;
    }
    segments.push({
      startTick: tick,
      endTick,
      startTime: time,
      hardEndTick: looping && lp ? lp.end : Number.POSITIVE_INFINITY,
      fresh,
    });
    tick = endTick;
    time = windowEndTime;
    fresh = false;
  }
  return { segments, next: { tick, time, fresh } };
}

export interface NoteEvent {
  note: MidiNote;
  /** absolute timeline ticks */
  onTick: number;
  offTick: number;
}

/**
 * Notes of a MIDI clip whose note-on falls inside [segStart, segEnd). Handles
 * looping clip content and clamps note ends to the clip end and `hardEnd`.
 */
export function collectClipNotes(clip: MidiClip, segStart: number, segEnd: number, hardEnd: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  const clipStart = clip.start;
  const clipEndTick = clip.start + clip.length;
  if (clipEndTick <= segStart || clipStart >= segEnd) return out;
  const cycle = clip.loop && clip.loopLength > 0 ? clip.loopLength : clip.length;
  const lo = Math.max(segStart, clipStart);
  const hi = Math.min(segEnd, clipEndTick);
  const firstCycle = Math.floor((lo - clipStart) / cycle);
  // (no epsilon here: a note a hair before `hi` belongs to this window, and the per-note check
  // below drops anything at or after `hi`; an epsilon could make a loop repeat's first note miss
  // both this window and the next)
  const lastCycle = Math.floor((hi - clipStart) / cycle);
  for (let c = Math.max(0, firstCycle); c <= lastCycle; c++) {
    const base = clipStart + c * cycle;
    for (const note of clip.notes) {
      if (note.start >= cycle) continue;
      const on = base + note.start;
      if (on < lo || on >= hi) continue;
      const end = Math.min(on + note.length, base + cycle, clipEndTick, hardEnd);
      if (end <= on) continue;
      out.push({ note, onTick: on, offTick: end });
    }
  }
  out.sort((a, b) => a.onTick - b.onTick || a.note.pitch - b.note.pitch);
  return out;
}

export interface AudioClipStart {
  clip: AudioClip;
  /** timeline tick at which playback starts */
  startTick: number;
  /** timeline tick at which playback stops */
  stopTick: number;
  /** seconds into the clip (from its timeline start) at which playback begins */
  clipOffsetSec: number;
}

/**
 * Determine whether an audio clip starts playing in this segment. On a fresh
 * segment a clip that is already underway starts mid-clip.
 */
export function collectAudioClipStart(clip: AudioClip, seg: Segment, bpm: number): AudioClipStart | null {
  const clipEndTick = clip.start + clip.length;
  const stopTick = Math.min(clipEndTick, seg.hardEndTick);
  if (clip.start >= seg.startTick && clip.start < seg.endTick) {
    if (stopTick <= clip.start) return null;
    return { clip, startTick: clip.start, stopTick, clipOffsetSec: 0 };
  }
  if (seg.fresh && clip.start < seg.startTick && clipEndTick > seg.startTick) {
    if (stopTick <= seg.startTick) return null;
    return {
      clip,
      startTick: seg.startTick,
      stopTick,
      clipOffsetSec: ticksToSeconds(seg.startTick - clip.start, bpm),
    };
  }
  return null;
}

/**
 * Source-audio position (seconds) for a time offset (timeline seconds) into an audio clip; a warped
 * clip moves through its source at warpRate (pass the project tempo).
 */
export function audioSourcePosition(clip: AudioClip, clipOffsetSec: number, projectBpm?: number): number {
  const src = projectBpm === undefined ? clipOffsetSec : clipOffsetSec * warpRate(clip, projectBpm);
  if (clip.loop && clip.loopSeconds > 0) {
    return clip.sourceOffset + ((clip.loopStartPhase + src) % clip.loopSeconds);
  }
  return clip.sourceOffset + src;
}

/** Beat ticks in [start, end) for the metronome. */
export function metronomeTicks(start: number, end: number, beatTicks: number, barTicks: number): { tick: number; accent: boolean }[] {
  const out: { tick: number; accent: boolean }[] = [];
  let t = Math.ceil(start / beatTicks - 1e-9) * beatTicks;
  for (; t < end; t += beatTicks) {
    const r = Math.round(t);
    out.push({ tick: r, accent: r % barTicks === 0 });
  }
  return out;
}

/**
 * Map an AudioContext time to a timeline tick using the anchors recorded at
 * each segment start. Anchors must be sorted by time.
 */
export interface Anchor {
  time: number;
  tick: number;
}

export function tickAtTime(anchors: Anchor[], time: number, bpm: number): number {
  let a: Anchor | undefined;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const cand = anchors[i];
    if (cand && cand.time <= time) {
      a = cand;
      break;
    }
  }
  a ??= anchors[0];
  if (!a) return 0;
  return a.tick + secondsToTicks(Math.max(0, time - a.time), bpm);
}

// ---------------------------------------------------------------------------
// Window planning: everything that must be scheduled for one scheduler pass.
// The Transport executes the plan against the audio graph; tests feed it
// straight into TriOscCore to verify timing end to end.
// ---------------------------------------------------------------------------

export interface PlannedNote {
  trackId: string;
  pitch: number;
  /** 0..1 */
  velocity: number;
  onTime: number;
  offTime: number;
}

export interface PlannedAudio {
  trackId: string;
  clip: AudioClip;
  when: number;
  stopAt: number;
  /** source seconds where playback starts */
  sourcePos: number;
  /** timeline seconds into the clip */
  clipOffset: number;
  /** source seconds per timeline second (warp; 1 = the audio's own speed) */
  rate: number;
}

export interface PlannedClick {
  time: number;
  accent: boolean;
}

export interface AutomationEvent {
  /** 'set' jumps at time (segment start), 'ramp' ramps from the previous event to value at time */
  kind: 'set' | 'ramp';
  time: number;
  value: number;
}

export interface PlannedAutomation {
  trackId: string;
  target: AutomationTarget;
  events: AutomationEvent[];
}

export interface WindowPlan {
  segments: Segment[];
  next: Cursor;
  notes: PlannedNote[];
  audio: PlannedAudio[];
  clicks: PlannedClick[];
  automation: PlannedAutomation[];
}

/**
 * Automation events for one lane in one segment.
 *
 * Each point P_i whose tick lies in the segment schedules the ramp *towards
 * the next point* P_{i+1} — even if that point is far beyond the lookahead —
 * so a long ramp is in the AudioParam timeline from its very start (adding it
 * later would make the value jump). A fresh segment (play/seek/loop wrap)
 * first sets the interpolated value at its start. Ramps never cross the
 * segment's hard end (loop end): they stop at the value the curve has there.
 */
export function planAutomation(points: readonly AutomationPoint[], seg: Segment, bpm: number): AutomationEvent[] {
  const ev: AutomationEvent[] = [];
  if (points.length === 0) return ev;
  const timeOf = (tick: number) => segmentTime(seg, tick, bpm);
  const rampToNextAfter = (idx: number) => {
    // first point strictly after index idx
    const next = points[idx + 1];
    if (next && next.tick <= seg.hardEndTick) ev.push({ kind: 'ramp', time: timeOf(next.tick), value: next.value });
    else if (next && Number.isFinite(seg.hardEndTick)) ev.push({ kind: 'ramp', time: timeOf(seg.hardEndTick), value: valueAt(points, seg.hardEndTick) ?? next.value });
  };
  let firstIdx = 0;
  if (seg.fresh) {
    ev.push({ kind: 'set', time: seg.startTime, value: valueAt(points, seg.startTick) as number });
    // index of the last point at or before the start; ramp toward the one after it
    let last = -1;
    for (let i = 0; i < points.length; i++) if ((points[i] as AutomationPoint).tick <= seg.startTick) last = i;
    rampToNextAfter(last);
    firstIdx = last + 1;
  }
  for (let i = firstIdx; i < points.length; i++) {
    const p = points[i] as AutomationPoint;
    if (p.tick < seg.startTick) continue;
    if (p.tick >= seg.endTick) break;
    if (seg.fresh && p.tick <= seg.startTick) continue;
    rampToNextAfter(i);
  }
  return ev;
}

export interface PlanContext {
  bpm: number;
  loop: LoopRegion;
  beatTicks: number;
  barTicks: number;
  metronome: boolean;
  /** tracks: id + kind (+ automation lanes), in project order */
  tracks: { id: string; kind: 'audio' | 'instrument'; automation?: AutomationLane[] }[];
  clips: Iterable<AudioClip | MidiClip>;
}

export function planWindow(ctx: PlanContext, cursor: Cursor, windowEndTime: number): WindowPlan {
  const { segments, next } = computeSegments(cursor, windowEndTime, ctx.bpm, ctx.loop);
  const plan: WindowPlan = { segments, next, notes: [], audio: [], clicks: [], automation: [] };
  if (!segments.length) return plan;
  const kinds = new Map(ctx.tracks.map((t) => [t.id, t.kind]));
  const clips = [...ctx.clips].filter((c) => kinds.has(c.trackId));
  for (const seg of segments) {
    for (const clip of clips) {
      if (clip.kind === 'midi') {
        if (kinds.get(clip.trackId) !== 'instrument') continue;
        for (const ev of collectClipNotes(clip, seg.startTick, seg.endTick, seg.hardEndTick)) {
          plan.notes.push({
            trackId: clip.trackId,
            pitch: ev.note.pitch,
            velocity: ev.note.velocity / 127,
            onTime: segmentTime(seg, ev.onTick, ctx.bpm),
            offTime: segmentTime(seg, ev.offTick, ctx.bpm),
          });
        }
      } else {
        const s = collectAudioClipStart(clip, seg, ctx.bpm);
        if (!s) continue;
        plan.audio.push({
          trackId: clip.trackId,
          clip,
          when: segmentTime(seg, s.startTick, ctx.bpm),
          stopAt: segmentTime(seg, s.stopTick, ctx.bpm),
          sourcePos: audioSourcePosition(clip, s.clipOffsetSec, ctx.bpm),
          clipOffset: s.clipOffsetSec,
          rate: warpRate(clip, ctx.bpm),
        });
      }
    }
    if (ctx.metronome) {
      for (const b of metronomeTicks(seg.startTick, seg.endTick, ctx.beatTicks, ctx.barTicks)) {
        plan.clicks.push({ time: segmentTime(seg, b.tick, ctx.bpm), accent: b.accent });
      }
    }
  }
  for (const t of ctx.tracks) {
    for (const lane of t.automation ?? []) {
      if (!lane.enabled || lane.points.length === 0) continue;
      const events = segments.flatMap((seg) => planAutomation(lane.points, seg, ctx.bpm));
      if (events.length) plan.automation.push({ trackId: t.id, target: lane.target, events });
    }
  }
  plan.notes.sort((a, b) => a.onTime - b.onTime || a.pitch - b.pitch);
  return plan;
}

/**
 * Convert planned automation events into explicit ramp segments for
 * instrument parameters (which aren't AudioParams). A ramp starts at the
 * previous event, so the caller passes the last event of the lane (across
 * scheduler passes) and gets the new last one back.
 */
/**
 * Keep a lane's events in time order across scheduler windows. Each window
 * computes times from its own segment origin, so the same musical position
 * can come out a hair (~1e-15 s) earlier in a later window. Web Audio sorts
 * parameter events by time, so such an event would jump ahead of one already
 * scheduled — e.g. the second point of a step (two points on one tick) landing
 * before the first, leaving the old value in place. Clamping to the previous
 * event's time keeps the order; events at the same time apply in the order
 * given, which is the step.
 */
export function inOrder<E extends { time: number }>(events: readonly E[], lastTime: number): { events: E[]; lastTime: number } {
  let t0 = lastTime;
  const out = events.map((e) => {
    const time = Math.max(e.time, t0);
    t0 = time;
    return time === e.time ? e : { ...e, time };
  });
  return { events: out, lastTime: t0 };
}

export function toParamSegments(
  key: string,
  events: AutomationEvent[],
  last: { time: number; value: number } | null,
  exp: boolean,
): { segments: { type: 'param'; time: number; key: string; fromValue: number; toTime: number; toValue: number; exp: boolean }[]; last: { time: number; value: number } | null } {
  const segments: { type: 'param'; time: number; key: string; fromValue: number; toTime: number; toValue: number; exp: boolean }[] = [];
  let prev = last;
  for (const e of inOrder(events, last?.time ?? -Infinity).events) {
    if (e.kind === 'set' || !prev) segments.push({ type: 'param', time: e.time, key, fromValue: e.value, toTime: e.time, toValue: e.value, exp });
    else segments.push({ type: 'param', time: prev.time, key, fromValue: prev.value, toTime: e.time, toValue: e.value, exp });
    prev = { time: e.time, value: e.value };
  }
  return { segments, last: prev };
}
