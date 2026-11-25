/**
 * Live side of the Gucci Slipper-izer: a key pressed on a chord-tool track
 * plays its chord immediately; in auto-play the held key plays the
 * progression in rhythm, scheduled a little ahead (like the transport) and
 * locked to the song grid while the transport runs.
 */
import { nextNoteInstanceId } from '../core/ids';
import { PPQ, ticksPerBar, ticksToSeconds } from '../core/time';
import { expandNote, type ChordToolConfig, type NoteLike } from '../chords/theory';
import type { Project } from '../project/types';
import type { InstrumentNode } from './instruments';
import type { Transport } from './transport';

interface Sounding {
  id: number;
  on: number;
  off: number;
}

interface Hold {
  trackId: string;
  events: NoteLike[];
  next: number;
  /** context time of tick 0 for this hold's events (free clock) or null = follow the transport */
  t0: number | null;
  bpm: number;
  sounding: Sounding[];
}

export interface LiveChordHost {
  ctx(): AudioContext | null;
  transport(): Transport | null;
  instrument(trackId: string): InstrumentNode | null | undefined;
  project(): Project | null;
}

const LOOKAHEAD = 0.12;
const PUMP_MS = 25;
/** how long auto-play keeps going while a key is held */
const AUTO_BARS = 64;
let virtualIds = 0x40000000;

export class LiveChords {
  private readonly holds = new Map<number, Hold>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: LiveChordHost) {}

  /** Start the chord(s) for one played key; returns a virtual note id for the matching note-off. */
  noteOn(trackId: string, cfg: ChordToolConfig, pitch: number, velocity: number): number | null {
    const ctx = this.host.ctx();
    const p = this.host.project();
    if (!ctx || !p || !this.host.instrument(trackId)) return null;
    const bar = ticksPerBar(p.timeSignature);
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const tr = this.host.transport();
    const following = cfg.play === 'auto' && !!tr?.isPlaying() && !tr.isCountingIn();
    const startTick = following && tr ? tr.getTick() : 0;
    const length = cfg.play === 'auto' ? AUTO_BARS * bar : 1e9;
    const events = expandNote(cfg, { pitch, start: startTick, length, velocity: vel }, bar, PPQ, 0);
    const vid = ++virtualIds;
    this.holds.set(vid, { trackId, events, next: 0, t0: following ? null : ctx.currentTime + 0.005, bpm: p.bpm, sounding: [] });
    this.pump();
    if (!this.timer) this.timer = setInterval(() => this.pump(), PUMP_MS);
    return vid;
  }

  noteOff(vid: number): boolean {
    const h = this.holds.get(vid);
    if (!h) return false;
    this.holds.delete(vid);
    const inst = this.host.instrument(h.trackId);
    const now = this.host.ctx()?.currentTime ?? 0;
    // end what is sounding now; notes scheduled to start later are ended right after their start
    for (const s of h.sounding) if (s.off > now) inst?.noteOff(s.id, Math.max(now, s.on + 0.002));
    this.stopTimerIfIdle();
    return true;
  }

  isLive(vid: number): boolean {
    return this.holds.has(vid);
  }

  /** Release every held chord (all tracks, or one). */
  releaseAll(trackId?: string): void {
    for (const [vid, h] of [...this.holds]) if (!trackId || h.trackId === trackId) this.noteOff(vid);
  }

  private stopTimerIfIdle(): void {
    if (!this.holds.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private timeOf(h: Hold, tick: number): number {
    const ctx = this.host.ctx();
    const now = ctx?.currentTime ?? 0;
    if (h.t0 !== null) return h.t0 + ticksToSeconds(tick, h.bpm);
    const tr = this.host.transport();
    const nowTick = tr?.getTick() ?? 0;
    return now + ticksToSeconds(tick - nowTick, h.bpm);
  }

  private pump(): void {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    for (const h of this.holds.values()) {
      const inst = this.host.instrument(h.trackId);
      if (!inst) continue;
      // forget notes that have finished
      h.sounding = h.sounding.filter((s) => s.off > now);
      while (h.next < h.events.length) {
        const e = h.events[h.next] as NoteLike;
        const on = Math.max(now, this.timeOf(h, e.start));
        if (on > horizon) break;
        h.next++;
        // a transport-following hold skips anything that is already in the past
        if (h.t0 === null && this.timeOf(h, e.start + e.length) <= now) continue;
        const off = this.timeOf(h, e.start + e.length);
        const id = nextNoteInstanceId();
        inst.noteOn(id, e.pitch, e.velocity / 127, on);
        // chord-mode notes are open-ended (released by noteOff); patterns end on their own
        const sustained = e.length >= 1e8;
        if (!sustained) inst.noteOff(id, Math.max(on + 0.002, off));
        h.sounding.push({ id, on, off: sustained ? Number.POSITIVE_INFINITY : off });
      }
    }
  }
}

