/**
 * Live side of the Arp / Step sequencer: keys held on an arp track become the
 * pattern, scheduled a little ahead like the transport. While the song plays
 * the steps sit on the song grid; when stopped they start right away on a
 * free clock. Latch keeps the pattern going after the keys are let go (the
 * next press starts a new set). Edits to the tool apply while it runs.
 */
import { nextNoteInstanceId } from '../core/ids';
import { PPQ, ticksToSeconds } from '../core/time';
import { stepNotes, type ArpConfig, type HeldNote } from '../arp/arp';
import type { Project } from '../project/types';
import type { InstrumentNode } from './instruments';
import type { Transport } from './transport';

export interface LiveArpHost {
  ctx(): AudioContext | null;
  transport(): Transport | null;
  instrument(trackId: string): InstrumentNode | null | undefined;
  project(): Project | null;
}

interface Session {
  trackId: string;
  /** held keys by virtual id (one press can hold several pitches: a chord from the Slipper-izer) */
  keys: Map<number, HeldNote[]>;
  /** latch: the keys were all let go, the set keeps playing until the next press */
  latched: boolean;
  /** next step index to schedule (on the song grid, or from the free clock's start) */
  next: number;
  since: number;
  lastKey: string;
  /** free clock: context time of step 0; null = follow the transport */
  t0: number | null;
  bpm: number;
}

const LOOKAHEAD = 0.12;
const PUMP_MS = 20;
let virtualIds = 0x50000000;
let order = 0;

/** a note the live arp schedules: track, pitch, velocity (1..127), context time, step index (on the song grid, or from the free clock's start) */
export type ArpNoteListener = (trackId: string, pitch: number, velocity: number, at: number, step: number) => void;

export class LiveArp {
  private readonly sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** visuals that follow the notes (the monkey) */
  readonly listeners = new Set<ArpNoteListener>();

  constructor(private readonly host: LiveArpHost) {}

  private cfg(trackId: string): ArpConfig | null {
    const t = this.host.project()?.tracks.find((x) => x.id === trackId);
    return t?.arp?.enabled ? t.arp : null;
  }

  private stepTicks(cfg: ArpConfig): number {
    return Math.max(1, Math.round(cfg.rate * PPQ));
  }

  /** A key went down: its pitch(es) join the held set. Returns a virtual id for the key-up. */
  keyDown(trackId: string, pitches: number[], velocity: number): number | null {
    const ctx = this.host.ctx();
    const cfg = this.cfg(trackId);
    const p = this.host.project();
    if (!ctx || !cfg || !p || !this.host.instrument(trackId)) return null;
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const vid = ++virtualIds;
    let s = this.sessions.get(trackId);
    if (s?.latched) {
      // a new press after a latched release starts a new set
      s.keys.clear();
      s.latched = false;
    }
    if (!s) {
      const tr = this.host.transport();
      const following = !!tr?.isPlaying() && !tr.isCountingIn();
      const st = this.stepTicks(cfg);
      s = {
        trackId,
        keys: new Map(),
        latched: false,
        next: following && tr ? Math.ceil(tr.getTick() / st) : 0,
        since: 0,
        lastKey: '',
        t0: following ? null : ctx.currentTime + 0.005,
        bpm: p.bpm,
      };
      this.sessions.set(trackId, s);
    }
    s.keys.set(
      vid,
      pitches.map((pitch) => ({ pitch, velocity: vel, order: ++order })),
    );
    this.pump();
    if (!this.timer) this.timer = setInterval(() => this.pump(), PUMP_MS);
    return vid;
  }

  /** A key went up. Returns false if the id isn't one of ours. */
  keyUp(vid: number): boolean {
    for (const s of this.sessions.values()) {
      if (!s.keys.has(vid)) continue;
      const cfg = this.cfg(s.trackId);
      if (cfg?.latch && s.keys.size === 1) {
        // the last key let go with Latch on: keep the set playing
        s.latched = true;
        return true;
      }
      s.keys.delete(vid);
      if (!s.keys.size) this.end(s.trackId);
      return true;
    }
    return false;
  }

  /** Stop a track's pattern (or all): what is sounding finishes on its own. */
  stop(trackId?: string): void {
    for (const id of [...this.sessions.keys()]) if (!trackId || id === trackId) this.end(id);
  }

  isRunning(trackId: string): boolean {
    return this.sessions.has(trackId);
  }

  private end(trackId: string): void {
    this.sessions.delete(trackId);
    if (!this.sessions.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private timeOfTick(s: Session, tick: number): number {
    const now = this.host.ctx()?.currentTime ?? 0;
    if (s.t0 !== null) return s.t0 + ticksToSeconds(tick, s.bpm);
    const tr = this.host.transport();
    return now + ticksToSeconds(tick - (tr?.getTick() ?? 0), s.bpm);
  }

  private pump(): void {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    for (const s of [...this.sessions.values()]) {
      const cfg = this.cfg(s.trackId);
      const inst = this.host.instrument(s.trackId);
      if (!cfg || !inst) {
        this.end(s.trackId);
        continue;
      }
      // a transport-following session whose song stopped continues on a free clock from here
      const tr = this.host.transport();
      if (s.t0 === null && !tr?.isPlaying()) s.t0 = now - ticksToSeconds(s.next * this.stepTicks(cfg), s.bpm);
      const st = this.stepTicks(cfg);
      const held = [...s.keys.values()].flat();
      const key = held.map((h) => h.pitch).sort((a, b) => a - b).join(',');
      if (key !== s.lastKey) {
        s.since = 0;
        s.lastKey = key;
      }
      for (let guard = 0; guard < 64; guard++) {
        const tick = s.next * st;
        const at = this.timeOfTick(s, tick);
        if (at > horizon) break;
        if (at >= now - 0.02) {
          for (const e of stepNotes(cfg, held, s.next, s.since, st)) {
            const on = Math.max(now, at + ticksToSeconds(e.offset, s.bpm));
            const off = on + Math.max(0.01, ticksToSeconds(e.length, s.bpm));
            const id = nextNoteInstanceId();
            inst.noteOn(id, e.pitch, e.velocity / 127, on);
            inst.noteOff(id, off);
            for (const l of this.listeners) l(s.trackId, e.pitch, e.velocity, on, s.next);
          }
        }
        s.next++;
        s.since++;
      }
    }
  }
}
