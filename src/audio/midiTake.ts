/**
 * MIDI take: collects live note input (already converted to timeline ticks)
 * during a recording and turns it into the notes of a new MIDI clip.
 *
 *  - Notes played during the count-in, or slightly before the record start,
 *    are pulled to the start tick.
 *  - The sustain pedal is baked into note lengths: a key released while the
 *    pedal is down keeps sounding until the pedal comes up (or the same pitch
 *    is struck again).
 *  - With the loop on, positions wrap: every pass is merged into one clip
 *    (a note held across the loop end is cut at the loop end). Recording can
 *    start mid-loop: later passes fill in the part before the start point.
 *
 * Pure and deterministic (unit tested); the recorder feeds it.
 */
import { createId } from '../core/ids';
import type { MidiNote } from '../project/types';

export interface LiveNote {
  pitch: number;
  start: number;
  /** null while the key is held */
  end: number | null;
  /** 1..127 */
  velocity: number;
}

/** shortest recorded note (a 1/128 note) so very short taps stay visible and audible */
const MIN_LENGTH = 30;

export class MidiTake {
  readonly startTick: number;
  private readonly loop: { start: number; end: number } | null;
  private readonly notes: LiveNote[] = [];
  /** notes whose key is down, by input key (channel·128 + pitch, or a voice id) */
  private readonly open = new Map<number, LiveNote>();
  private pedal = false;
  /** released while the pedal was down: end when the pedal comes up */
  private readonly pedalHeld: LiveNote[] = [];

  constructor(startTick: number, loop: { start: number; end: number } | null = null) {
    this.startTick = Math.max(0, Math.round(startTick));
    this.loop = loop && loop.end > loop.start ? loop : null;
  }

  private clampTick(tick: number): number {
    const t = Math.round(tick);
    // With the loop on, the transport reports wrapped positions: a tick inside the loop
    // but before the record start is a later pass, not an early note. (Count-in notes
    // never arrive below the start: the transport holds its position until playback
    // begins.)
    if (this.loop && t >= this.loop.start && t < this.loop.end) return t;
    return Math.max(this.startTick, t);
  }

  /** end a note, handling loop wrap-around and the minimum length */
  private close(n: LiveNote, tick: number): void {
    let end = Math.round(tick);
    const inLoop = this.loop && n.start >= this.loop.start && n.start < this.loop.end;
    if (end <= n.start && inLoop) end = this.loop!.end;
    n.end = Math.max(end, n.start + MIN_LENGTH);
    // the minimum length never carries a note past the loop end (that would grow the clip by a bar)
    if (inLoop) n.end = Math.min(n.end, this.loop!.end);
  }

  noteOn(key: number, pitch: number, velocity: number, tick: number): void {
    const t = this.clampTick(tick);
    const prev = this.open.get(key);
    if (prev) {
      this.close(prev, t);
      this.open.delete(key);
    }
    // re-striking a pitch that rings only because of the pedal ends the old note
    for (let i = this.pedalHeld.length - 1; i >= 0; i--) {
      const h = this.pedalHeld[i] as LiveNote;
      if (h.pitch === pitch) {
        this.close(h, t);
        this.pedalHeld.splice(i, 1);
      }
    }
    const n: LiveNote = { pitch, start: t, end: null, velocity: Math.min(127, Math.max(1, Math.round(velocity * 127))) };
    this.notes.push(n);
    this.open.set(key, n);
  }

  noteOff(key: number, tick: number): void {
    const n = this.open.get(key);
    if (!n) return;
    this.open.delete(key);
    if (this.pedal) this.pedalHeld.push(n);
    else this.close(n, this.clampTick(tick));
  }

  sustain(on: boolean, tick: number): void {
    if (on === this.pedal) return;
    this.pedal = on;
    if (on) return;
    const t = this.clampTick(tick);
    for (const n of this.pedalHeld) this.close(n, t);
    this.pedalHeld.length = 0;
  }

  /** notes so far (open ones have end = null), for drawing the take live */
  live(): readonly LiveNote[] {
    return this.notes;
  }

  get noteCount(): number {
    return this.notes.length;
  }

  /**
   * Close every held note at `endTick` and lay the take out as a clip:
   * bar-aligned start/length covering the notes and the recorded span.
   * Returns null if nothing was played.
   */
  finish(endTick: number, barTicks: number): { start: number; length: number; notes: MidiNote[] } | null {
    const end = Math.max(this.startTick, Math.round(endTick));
    for (const n of this.open.values()) this.close(n, end);
    this.open.clear();
    for (const n of this.pedalHeld) this.close(n, end);
    this.pedalHeld.length = 0;
    if (!this.notes.length) return null;
    let lo = this.startTick;
    let hi = this.loop ? 0 : end;
    for (const n of this.notes) {
      lo = Math.min(lo, n.start);
      hi = Math.max(hi, n.end ?? n.start);
    }
    const bar = Math.max(1, barTicks);
    const start = Math.floor(lo / bar) * bar;
    const stop = Math.max(start + bar, Math.ceil(hi / bar) * bar);
    const notes: MidiNote[] = this.notes
      .map((n) => ({ id: createId('n'), pitch: n.pitch, start: n.start - start, length: (n.end ?? n.start + MIN_LENGTH) - n.start, velocity: n.velocity }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    return { start, length: stop - start, notes };
  }
}

/**
 * The AudioContext time the listener was hearing at a performance.now()
 * timestamp. Players play along to what comes out of the speakers, so the
 * note belongs to the timeline position that was audible then.
 */
export function heardContextTime(
  eventMs: number,
  out: { contextTime?: number; performanceTime?: number } | null,
  fallback: { currentTime: number; outputLatency?: number; baseLatency?: number; nowMs: number },
): number {
  if (out && typeof out.contextTime === 'number' && typeof out.performanceTime === 'number' && out.performanceTime > 0) {
    return out.contextTime + (eventMs - out.performanceTime) / 1000;
  }
  return fallback.currentTime - (fallback.outputLatency ?? 0) - (fallback.baseLatency ?? 0) - (fallback.nowMs - eventMs) / 1000;
}
