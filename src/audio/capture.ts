/**
 * Capture (retrospective MIDI, pure; unit tested): every instrument track
 * keeps its last minute of live note input — note on / off and the sustain
 * pedal, with the moment it was played and, while the transport ran, the
 * timeline tick that was audible then — whether anything records or not. If
 * you like what you just jammed, Capture turns it into a clip.
 *
 * The buffer is cheap and bounded: per track, one ring of typed arrays
 * (CAPTURE_CAPACITY events, ≈ 110 kB, allocated on the track's first note)
 * written in place — no allocation per event; reading allocates, but only
 * when capturing or drawing the preview.
 *
 * buildCapture lays a window of it out as notes, with MidiTake (the MIDI
 * recorder's own logic: sustain baked into note lengths, loop passes merged):
 *  - the window: the last `bars` bars (at the current tempo) up to the last
 *    thing played, or up to now while a key is still held; a note struck
 *    before the window isn't taken, a key still held ends at the window end;
 *  - played while the transport ran: the notes go where they were heard
 *    (loop passes merged into one pass, like a recording with the loop on);
 *  - otherwise (any of them played while stopped): the timing between the
 *    notes is kept, at the current tempo, from the first one — the caller
 *    puts the clip at the playhead or the next free bar.
 */
import { MidiTake } from './midiTake';
import type { MidiNote } from '../project/types';

/** how far back the buffer reaches */
export const CAPTURE_SECONDS = 60;
/** events kept per track (a dense minute of playing; the oldest are overwritten) */
export const CAPTURE_CAPACITY = 4096;

const ON = 0;
const OFF = 1;
const PEDAL_DOWN = 2;
const PEDAL_UP = 3;

export type CaptureEvent =
  /** velocity 1..127; tick NaN = played while the transport was stopped */
  | { kind: 'on'; key: number; pitch: number; velocity: number; at: number; tick: number }
  | { kind: 'off'; key: number; at: number; tick: number }
  | { kind: 'pedal'; down: boolean; at: number; tick: number };

class Ring {
  private readonly at: Float64Array;
  private readonly tick: Float64Array;
  private readonly key: Float64Array;
  private readonly kind: Uint8Array;
  private readonly pitch: Uint8Array;
  private readonly vel: Uint8Array;
  private next = 0;
  size = 0;

  constructor(readonly capacity: number) {
    this.at = new Float64Array(capacity);
    this.tick = new Float64Array(capacity);
    this.key = new Float64Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.pitch = new Uint8Array(capacity);
    this.vel = new Uint8Array(capacity);
  }

  push(kind: number, key: number, pitch: number, vel: number, at: number, tick: number): void {
    const i = this.next;
    this.kind[i] = kind;
    this.key[i] = key;
    this.pitch[i] = pitch;
    this.vel[i] = vel;
    this.at[i] = at;
    this.tick[i] = tick;
    this.next = (i + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** events at or after `since`, oldest first */
  read(since: number): CaptureEvent[] {
    const out: CaptureEvent[] = [];
    const first = (this.next - this.size + this.capacity) % this.capacity;
    for (let k = 0; k < this.size; k++) {
      const i = (first + k) % this.capacity;
      const at = this.at[i] as number;
      if (at < since) continue;
      const tick = this.tick[i] as number;
      const kind = this.kind[i];
      if (kind === ON) out.push({ kind: 'on', key: this.key[i] as number, pitch: this.pitch[i] as number, velocity: this.vel[i] as number, at, tick });
      else if (kind === OFF) out.push({ kind: 'off', key: this.key[i] as number, at, tick });
      else out.push({ kind: 'pedal', down: kind === PEDAL_DOWN, at, tick });
    }
    return out;
  }
}

export class CaptureBuffer {
  private readonly rings = new Map<string, Ring>();
  /** the instrument track something was last played on (Capture's default target) */
  lastTrackId: string | null = null;

  constructor(
    readonly capacity = CAPTURE_CAPACITY,
    readonly seconds = CAPTURE_SECONDS,
  ) {}

  private ring(trackId: string): Ring {
    let r = this.rings.get(trackId);
    if (!r) this.rings.set(trackId, (r = new Ring(this.capacity)));
    return r;
  }

  /** `velocity` 0..1 (as the engine gets it), `at` performance.now() ms, `tick` NaN while stopped */
  noteOn(trackId: string, key: number, pitch: number, velocity: number, at: number, tick: number): void {
    this.ring(trackId).push(ON, key, Math.min(127, Math.max(0, Math.round(pitch))), Math.min(127, Math.max(1, Math.round(velocity * 127))), at, tick);
    this.lastTrackId = trackId;
  }

  noteOff(trackId: string, key: number, at: number, tick: number): void {
    this.rings.get(trackId)?.push(OFF, key, 0, 0, at, tick);
  }

  sustain(trackId: string, down: boolean, at: number, tick: number): void {
    this.ring(trackId).push(down ? PEDAL_DOWN : PEDAL_UP, 0, 0, 0, at, tick);
  }

  /** a track's events of the last `seconds`, oldest first */
  events(trackId: string, nowMs: number): CaptureEvent[] {
    return this.rings.get(trackId)?.read(nowMs - this.seconds * 1000) ?? [];
  }

  /** how many events a track holds (≤ capacity) */
  size(trackId: string): number {
    return this.rings.get(trackId)?.size ?? 0;
  }

  /** forget a track (it was deleted) */
  drop(trackId: string): void {
    this.rings.delete(trackId);
    if (this.lastTrackId === trackId) this.lastTrackId = null;
  }
}

export interface CaptureOptions {
  nowMs: number;
  /** how many bars back from the last thing played */
  bars: number;
  bpm: number;
  barTicks: number;
  ppq: number;
  /** the tick heard now, if the transport is playing (where still-held keys end) */
  nowTick: number | null;
  /** the loop at capture time (passes are merged into it), if on */
  loop: { start: number; end: number } | null;
}

export interface CaptureResult {
  /** timeline: `start` is where the notes were played; relative: `start` is 0 — the caller places the clip */
  mode: 'timeline' | 'relative';
  start: number;
  length: number;
  notes: MidiNote[];
  /** the window, ms */
  fromMs: number;
  toMs: number;
  /** keys still held at capture time (they end at the window end) */
  held: number;
}

/** The milliseconds one bar lasts at a tempo. */
export function barMs(o: Pick<CaptureOptions, 'bpm' | 'barTicks' | 'ppq'>): number {
  return ((o.barTicks / o.ppq) * 60000) / o.bpm;
}

/** Lay a window of a track's events out as clip notes (see the module comment). Null: nothing played. */
export function buildCapture(events: readonly CaptureEvent[], o: CaptureOptions): CaptureResult | null {
  // keys still down now
  const down = new Set<number>();
  for (const e of events) {
    if (e.kind === 'on') down.add(e.key);
    else if (e.kind === 'off') down.delete(e.key);
  }
  const last = events[events.length - 1];
  if (!last) return null;
  const held = down.size;
  const toMs = held ? Math.max(last.at, o.nowMs) : last.at;
  const fromMs = toMs - Math.max(1, o.bars) * barMs(o);
  const win = events.filter((e) => e.at >= fromMs);
  const ons = win.filter((e): e is Extract<CaptureEvent, { kind: 'on' }> => e.kind === 'on');
  const firstOn = ons[0];
  if (!firstOn) return null;
  // the pedal may have gone down before the window
  let pedal = false;
  for (const e of events) {
    if (e.at >= fromMs) break;
    if (e.kind === 'pedal') pedal = e.down;
  }
  const timeline = ons.every((e) => Number.isFinite(e.tick));
  let take: MidiTake;
  let endTick: number;
  if (timeline) {
    take = new MidiTake(Math.min(...ons.map((e) => e.tick)), o.loop);
    // an event after the transport stopped (a key let go later) counts at the last heard position
    let lastTick = firstOn.tick;
    if (pedal) take.sustain(true, firstOn.tick);
    for (const e of win) {
      if (Number.isFinite(e.tick)) lastTick = e.tick;
      feed(take, e, lastTick);
    }
    endTick = held && o.nowTick !== null ? o.nowTick : lastTick;
  } else {
    const toTick = (ms: number) => Math.round(((ms - firstOn.at) / 60000) * o.bpm * o.ppq);
    take = new MidiTake(0, null);
    if (pedal) take.sustain(true, 0);
    for (const e of win) feed(take, e, toTick(e.at));
    endTick = toTick(toMs);
  }
  const res = take.finish(endTick, o.barTicks);
  if (!res) return null;
  return { mode: timeline ? 'timeline' : 'relative', ...res, fromMs, toMs, held };
}

function feed(take: MidiTake, e: CaptureEvent, tick: number): void {
  if (e.kind === 'on') take.noteOn(e.key, e.pitch, e.velocity / 127, tick);
  else if (e.kind === 'off') take.noteOff(e.key, tick);
  else take.sustain(e.down, tick);
}

/**
 * Where a relative capture goes: the playhead's bar if the track is free
 * there for `length` ticks, else the first bar after the clips in the way.
 */
export function freeBarFrom(clips: readonly { start: number; length: number }[], fromTick: number, length: number, barTicks: number): number {
  const bar = Math.max(1, barTicks);
  let start = Math.max(0, Math.floor(fromTick / bar) * bar);
  for (let guard = 0; guard < 10000; guard++) {
    const hit = clips.find((c) => c.start < start + length && c.start + c.length > start);
    if (!hit) return start;
    start = Math.ceil((hit.start + hit.length) / bar) * bar;
  }
  return start;
}
