/**
 * Central transport with lookahead scheduling.
 *
 * Every `intervalMs` the scheduler schedules everything that falls in
 * [cursor.time, now + lookahead) with exact AudioContext timestamps: audio
 * clip sources via AudioBufferSourceNode.start(when), synth notes via
 * timestamped messages that the worklet applies at sample precision.
 *
 * Any change that invalidates what is already scheduled (seek, BPM change,
 * timeline edit, loop change) calls `reschedule()`: future events are
 * cancelled, sounding notes are released, and scheduling restarts from the
 * current musical position a few milliseconds in the future.
 */
import { nextNoteInstanceId } from '../core/ids';
import { PPQ, ticksPerBar, ticksPerBeatUnit } from '../core/time';
import type { Project } from '../project/types';
import type { SynthEvent } from '../synth/dsp/TriOscCore';
import { SchedulerClock } from './clock';
import { planWindow, tickAtTime, toParamSegments, type Anchor, type Cursor, type WindowPlan } from './scheduling';
import { targetInfo } from '../project/automation';
import type { TrackChannel } from './trackChannel';

export interface TransportHost {
  readonly ctx: AudioContext;
  getProject(): Project;
  channel(trackId: string): TrackChannel | undefined;
  audioBuffer(assetId: string): AudioBuffer | undefined;
  metronomeOut(): AudioNode;
  /** MIDI-triggered modulation: note-ons (time + pitch) from a source track */
  modTrigger?(trackId: string, notes: { time: number; note: number }[]): void;
  modCancel?(time: number): void;
}

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface TransportSnapshot {
  state: TransportState;
  countingIn: boolean;
}

export interface PlayOptions {
  countInBars?: number;
  fromTick?: number;
}

export class Transport {
  /** seconds scheduled ahead of currentTime */
  lookahead = 0.15;
  /** scheduler wake-up interval */
  intervalMs = 25;
  /** delay between pressing play and the first sample, for scheduling headroom */
  startLatency = 0.05;

  private readonly host: TransportHost;
  private readonly clock: SchedulerClock;
  private state: TransportState = 'stopped';
  private position = 0;
  private playStartTick = 0;
  private cursor: Cursor = { tick: 0, time: 0, fresh: true };
  private anchors: Anchor[] = [];
  private bpm = 120;
  private countInEnd = 0;
  /** AudioContext time at which the current playback reaches playStartTick (after any count-in) */
  private startTime = 0;
  private readonly clicks = new Set<OscillatorNode>();
  /** AudioParams that currently carry scheduled automation (cancelled on reschedule/stop) */
  private readonly automatedParams = new Set<AudioParam>();
  /** last scheduled automation event per instrument-param lane (ramps start there) */
  private readonly instAutoLast = new Map<string, { time: number; value: number }>();
  private readonly listeners = new Set<(s: TransportSnapshot) => void>();

  constructor(host: TransportHost) {
    this.host = host;
    this.clock = new SchedulerClock(() => this.pump());
  }

  subscribe(fn: (s: TransportSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  snapshot(): TransportSnapshot {
    return { state: this.state, countingIn: this.isCountingIn() };
  }

  /** Where and when the current playback started (time is after the count-in). */
  playStartInfo(): { tick: number; time: number } {
    return { tick: this.playStartTick, time: this.startTime };
  }

  isPlaying(): boolean {
    return this.state === 'playing';
  }

  isCountingIn(): boolean {
    return this.state === 'playing' && this.host.ctx.currentTime < this.countInEnd;
  }

  /** Current musical position in (fractional) ticks. */
  getTick(): number {
    if (this.state !== 'playing') return this.position;
    return tickAtTime(this.anchors, this.host.ctx.currentTime, this.bpm);
  }

  play(opts: PlayOptions = {}): void {
    const ctx = this.host.ctx;
    if (ctx.state !== 'running') void ctx.resume();
    if (this.state === 'playing') return;
    const project = this.host.getProject();
    this.bpm = project.bpm;
    const start = opts.fromTick ?? this.position;
    this.playStartTick = start;
    let t0 = ctx.currentTime + this.startLatency;
    const countIn = Math.max(0, Math.round(opts.countInBars ?? 0));
    this.countInEnd = 0;
    if (countIn > 0) {
      const ts = project.timeSignature;
      const beat = ticksPerBeatUnit(ts);
      const secPerBeat = (60 / this.bpm) * (beat / PPQ);
      const beats = countIn * ts.numerator;
      for (let i = 0; i < beats; i++) this.click(t0 + i * secPerBeat, i % ts.numerator === 0);
      t0 += beats * secPerBeat;
      this.countInEnd = t0;
    }
    this.cursor = { tick: start, time: t0, fresh: true };
    this.anchors = [{ time: t0, tick: start }];
    this.startTime = t0;
    this.state = 'playing';
    this.pump();
    this.clock.start(this.intervalMs);
    this.emit();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.position = Math.max(0, this.getTick());
    this.halt();
    this.state = 'paused';
    this.emit();
  }

  /** Stop: return to where playback started; a second stop returns to zero. */
  stop(): void {
    if (this.state === 'playing') {
      this.halt();
      this.position = this.playStartTick;
    } else {
      this.position = 0;
    }
    this.state = 'stopped';
    this.emit();
  }

  togglePlay(): void {
    if (this.state === 'playing') this.stop();
    else this.play();
  }

  seek(tick: number): void {
    const t = Math.max(0, tick);
    if (this.state === 'playing') {
      this.restartAt(t);
      this.playStartTick = t;
    } else {
      this.position = t;
      this.emit();
    }
  }

  /** Re-plan everything from the current position (after edits, BPM or loop changes). */
  reschedule(): void {
    if (this.state !== 'playing') {
      this.bpm = this.host.getProject().bpm;
      return;
    }
    if (this.isCountingIn()) {
      // keep the count-in clicks; just rebuild from the planned start
      this.cancelScheduled(this.countInEnd, false);
      this.bpm = this.host.getProject().bpm;
      this.cursor = { tick: this.playStartTick, time: this.countInEnd, fresh: true };
      this.anchors = [{ time: this.countInEnd, tick: this.playStartTick }];
      this.pump();
      return;
    }
    // position at the restart moment (old tempo), so the playhead stays continuous
    const tick = tickAtTime(this.anchors, this.host.ctx.currentTime + 0.02, this.bpm);
    this.restartAt(tick);
  }

  private restartAt(tick: number): void {
    const ctx = this.host.ctx;
    const t = ctx.currentTime + 0.02;
    this.cancelScheduled(t, true);
    this.bpm = this.host.getProject().bpm;
    this.countInEnd = 0;
    this.cursor = { tick, time: t, fresh: true };
    this.anchors = [{ time: t, tick }];
    this.pump();
  }

  private halt(): void {
    this.clock.stop();
    this.cancelScheduled(this.host.ctx.currentTime, true);
    this.countInEnd = 0;
  }

  /** Cancel everything scheduled at/after `time` on all channels. */
  private cancelScheduled(time: number, includeClicks: boolean): void {
    const project = this.host.getProject();
    for (const track of project.tracks) {
      const ch = this.host.channel(track.id);
      if (!ch) continue;
      ch.stopSources(time);
      ch.instrument?.cancel(time);
    }
    this.host.modCancel?.(time);
    this.instAutoLast.clear();
    // freeze automated params at their current curve value; new events replace the rest
    for (const p of this.automatedParams) holdParam(p, time);
    this.automatedParams.clear();
    if (includeClicks) {
      for (const c of this.clicks) {
        try {
          c.stop(time);
        } catch {
          // already stopped
        }
      }
    }
  }

  /** One scheduler pass. */
  private pump(): void {
    if (this.state !== 'playing') return;
    const ctx = this.host.ctx;
    const now = ctx.currentTime;
    const project = this.host.getProject();
    if (this.cursor.time < now) {
      // We fell behind (tab throttled / main thread blocked). Skip the missed
      // span instead of piling late events up at "now".
      const lateTick = tickAtTime(this.anchors, now, this.bpm);
      this.cursor = { tick: lateTick, time: now + 0.01, fresh: true };
      const lp = project.loop;
      if (lp.enabled && lateTick >= lp.end && lp.end > lp.start) {
        this.cursor.tick = lp.start + ((lateTick - lp.start) % (lp.end - lp.start));
      }
      this.anchors.push({ time: this.cursor.time, tick: this.cursor.tick });
    }
    const ts = project.timeSignature;
    const plan = planWindow(
      {
        bpm: this.bpm,
        loop: project.loop,
        beatTicks: ticksPerBeatUnit(ts),
        barTicks: ticksPerBar(ts),
        metronome: project.metronome,
        tracks: project.tracks,
        clips: Object.values(project.clips),
      },
      this.cursor,
      now + this.lookahead,
    );
    if (plan.segments.length === 0) return;
    for (const seg of plan.segments) {
      if (!seg.fresh) continue;
      const last = this.anchors[this.anchors.length - 1];
      if (!last || last.time !== seg.startTime || last.tick !== seg.startTick) {
        this.anchors.push({ time: seg.startTime, tick: seg.startTick });
      }
    }
    this.execute(plan);
    this.cursor = plan.next;
    // prune anchors that can no longer be the current one
    while (this.anchors.length > 1 && (this.anchors[1] as Anchor).time <= now) this.anchors.shift();
  }

  /** Turn a window plan into scheduled audio: synth events, buffer sources, clicks. */
  private execute(plan: WindowPlan): void {
    const byTrack = new Map<string, SynthEvent[]>();
    for (const n of plan.notes) {
      let evs = byTrack.get(n.trackId);
      if (!evs) byTrack.set(n.trackId, (evs = []));
      // unique id per scheduled note instance → note-off releases exactly this voice
      const id = nextNoteInstanceId();
      evs.push({ type: 'noteOn', time: n.onTime, id, note: n.pitch, velocity: n.velocity });
      evs.push({ type: 'noteOff', time: n.offTime, id });
    }
    for (const [trackId, evs] of byTrack) this.host.channel(trackId)?.instrument?.schedule(evs);
    if (this.host.modTrigger) {
      const onsByTrack = new Map<string, { time: number; note: number }[]>();
      for (const n of plan.notes) {
        const arr = onsByTrack.get(n.trackId) ?? [];
        arr.push({ time: n.onTime, note: n.pitch });
        onsByTrack.set(n.trackId, arr);
      }
      for (const [trackId, notes] of onsByTrack) this.host.modTrigger(trackId, notes);
    }
    for (const a of plan.audio) {
      const ch = this.host.channel(a.trackId);
      const buffer = this.host.audioBuffer(a.clip.assetId);
      if (!ch || !buffer) continue;
      const clip = a.clip;
      ch.playAudio({
        buffer,
        when: a.when,
        stopAt: a.stopAt,
        sourcePos: a.sourcePos,
        gain: clip.gain,
        loop: clip.loop && clip.loopSeconds > 0 ? { start: clip.sourceOffset, end: clip.sourceOffset + clip.loopSeconds } : null,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        clipOffset: a.clipOffset,
        clipDuration: (clip.length * 60) / (this.bpm * PPQ),
      });
    }
    for (const c of plan.clicks) this.click(c.time, c.accent);
    for (const a of plan.automation) {
      if (a.target.kind === 'inst') {
        // instrument parameters: explicit ramp segments the instrument applies itself
        const track = this.host.getProject().tracks.find((t) => t.id === a.trackId);
        const exp = track ? targetInfo(track, a.target)?.spec.curve === 'exp' : false;
        const lk = `${a.trackId}|${a.target.param}`;
        const { segments, last } = toParamSegments(a.target.param, a.events, this.instAutoLast.get(lk) ?? null, exp);
        if (last) this.instAutoLast.set(lk, last);
        this.host.channel(a.trackId)?.instrument?.schedule(segments);
        continue;
      }
      const targets = this.host.channel(a.trackId)?.automationParams(a.target) ?? [];
      for (const t of targets) {
        this.automatedParams.add(t.param);
        for (const e of a.events) {
          const v = t.map(e.value);
          if (e.kind === 'set') t.param.setValueAtTime(v, e.time);
          else if (t.exp && v > 0) t.param.exponentialRampToValueAtTime(v, e.time);
          else t.param.linearRampToValueAtTime(v, e.time);
        }
      }
    }
  }

  private click(time: number, accent: boolean): void {
    const ctx = this.host.ctx;
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: accent ? 1760 : 1175 });
    const g = new GainNode(ctx, { gain: 0 });
    osc.connect(g);
    g.connect(this.host.metronomeOut());
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.start(time);
    osc.stop(time + 0.06);
    this.clicks.add(osc);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
      this.clicks.delete(osc);
    };
  }

  dispose(): void {
    this.halt();
    this.clock.dispose();
  }
}

/** Cancel future automation on a param but keep its value at `time` (no jump). */
function holdParam(p: AudioParam, time: number): void {
  const withHold = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof withHold.cancelAndHoldAtTime === 'function') {
    withHold.cancelAndHoldAtTime(time);
  } else {
    // Firefox: no cancelAndHoldAtTime — approximate with the current value
    const v = p.value;
    p.cancelScheduledValues(time);
    p.setValueAtTime(v, time);
  }
}
