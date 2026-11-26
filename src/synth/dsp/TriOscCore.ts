/**
 * Sample-accurate event handling around TriOscSynth.
 *
 * The main thread schedules events with AudioContext timestamps (seconds).
 * The core converts them to frame positions and, while rendering each block,
 * splits the block at every event so a note starts on its exact sample.
 * Events with time < 0 apply at the start of the next block (live input).
 */
import type { TriOscPatch } from '../params';
import { TriOscSynth } from './TriOscSynth';
import { PITCH_BEND_KEY } from './bend';

export type SynthEvent =
  | { type: 'noteOn'; time: number; id: number; note: number; velocity: number }
  | { type: 'noteOff'; time: number; id: number }
  | { type: 'sustain'; time: number; on: boolean }
  | { type: 'bend'; time: number; value: number }
  | { type: 'allNotesOff'; time: number }
  /**
   * Automation segment for a patch parameter (dotted path, e.g. "ampEnv.release"):
   * ramps from fromValue at `time` to toValue at `toTime` (equal times = a jump).
   */
  | { type: 'param'; time: number; key: string; fromValue: number; toTime: number; toValue: number; exp: boolean };

/** Messages accepted by the processor port. */
export type SynthMessage =
  | SynthEvent
  | { type: 'events'; events: SynthEvent[] }
  /** Drop queued events at or after `time`, then release all notes at `time`. */
  | { type: 'cancel'; time: number }
  | { type: 'panic' }
  | { type: 'patch'; patch: TriOscPatch }
  /** parameter keys currently owned by automation (static patch updates won't override them) */
  | { type: 'autoKeys'; keys: string[] }
  /** set an automated parameter immediately (transport stopped / seeking) */
  | { type: 'autoValue'; key: string; value: number };

interface QueuedEvent {
  frame: number;
  ev: SynthEvent;
}

interface Ramp {
  fromFrame: number;
  fromValue: number;
  toFrame: number;
  toValue: number;
  exp: boolean;
}

/** Set a dotted parameter path on a patch in place ("master", "ampEnv.release", "osc1.level"). */
export function setPatchPath(patch: TriOscPatch, key: string, value: number): boolean {
  const [a, b] = key.split('.');
  if (a === 'master' && !b) {
    patch.master = value;
    return true;
  }
  const osc = /^osc(\d)$/.exec(a ?? '');
  const obj = (osc ? patch.oscs[Number(osc[1])] : (patch as unknown as Record<string, unknown>)[a ?? '']) as Record<string, unknown> | undefined;
  if (!obj || !b || typeof obj[b] !== 'number') return false;
  obj[b] = value;
  return true;
}

/**
 * Deep copy of a patch. (structuredClone is not available in
 * AudioWorkletGlobalScope, and this code runs there.) Only called on
 * construction and on patch messages, never per block.
 */
function clonePatch(p: TriOscPatch): TriOscPatch {
  return JSON.parse(JSON.stringify(p)) as TriOscPatch;
}

export class TriOscCore {
  readonly synth: TriOscSynth;
  private readonly sampleRate: number;
  private queue: QueuedEvent[] = [];
  /** our own copy of the patch, mutated in place by automation */
  private patch: TriOscPatch;
  private readonly ramps = new Map<string, Ramp>();
  private readonly autoValues = new Map<string, number>();
  private autoKeys = new Set<string>();

  constructor(sampleRate: number, patch?: TriOscPatch) {
    this.sampleRate = sampleRate;
    this.synth = new TriOscSynth(sampleRate, patch);
    this.patch = clonePatch(this.synth.getPatch());
    this.synth.setPatch(this.patch);
  }

  private applyParam(key: string, value: number): void {
    if (key === PITCH_BEND_KEY) {
      this.autoValues.set(key, value);
      this.synth.setPitchBend(Math.max(-1, Math.min(1, value)));
      return;
    }
    if (setPatchPath(this.patch, key, value)) {
      this.autoValues.set(key, value);
      this.synth.setPatch(this.patch);
    }
  }

  /** Advance active automation ramps to `frame`. */
  private updateRamps(frame: number): void {
    for (const [key, r] of this.ramps) {
      let v: number;
      if (frame >= r.toFrame || r.toFrame <= r.fromFrame) {
        v = r.toValue;
        this.ramps.delete(key);
      } else {
        const t = Math.max(0, (frame - r.fromFrame) / (r.toFrame - r.fromFrame));
        v = r.exp && r.fromValue > 0 && r.toValue > 0 ? r.fromValue * Math.pow(r.toValue / r.fromValue, t) : r.fromValue + (r.toValue - r.fromValue) * t;
      }
      this.applyParam(key, v);
    }
  }

  private toFrame(time: number): number {
    return time < 0 ? -1 : Math.round(time * this.sampleRate);
  }

  private enqueue(ev: SynthEvent): void {
    const frame = this.toFrame(ev.time);
    const q = this.queue;
    // binary search for the insertion point after all events with frame <= this one (stable)
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((q[mid] as QueuedEvent).frame <= frame) lo = mid + 1;
      else hi = mid;
    }
    q.splice(lo, 0, { frame, ev });
  }

  handleMessage(msg: SynthMessage): void {
    switch (msg.type) {
      case 'patch':
        // static edits apply, except parameters automation currently owns
        this.patch = clonePatch(msg.patch);
        for (const k of this.autoKeys) {
          const v = this.autoValues.get(k);
          if (v !== undefined) setPatchPath(this.patch, k, v);
        }
        this.synth.setPatch(this.patch);
        break;
      case 'autoKeys':
        // a pitch-bend lane that goes away leaves the pitch centred
        if (this.autoKeys.has(PITCH_BEND_KEY) && !msg.keys.includes(PITCH_BEND_KEY)) this.synth.setPitchBend(0);
        this.autoKeys = new Set(msg.keys);
        for (const k of [...this.autoValues.keys()]) if (!this.autoKeys.has(k)) this.autoValues.delete(k);
        for (const k of [...this.ramps.keys()]) if (!this.autoKeys.has(k)) this.ramps.delete(k);
        break;
      case 'autoValue':
        this.ramps.delete(msg.key);
        this.applyParam(msg.key, msg.value);
        break;
      case 'panic':
        this.queue = [];
        this.synth.panic();
        break;
      case 'cancel': {
        const f = this.toFrame(msg.time);
        this.queue = f < 0 ? [] : this.queue.filter((e) => e.frame < f);
        this.ramps.clear(); // automated values hold where they are; new segments follow
        this.enqueue({ type: 'allNotesOff', time: msg.time });
        break;
      }
      case 'events':
        for (const e of msg.events) this.enqueue(e);
        break;
      default:
        this.enqueue(msg);
    }
  }

  private apply(ev: SynthEvent): void {
    const s = this.synth;
    switch (ev.type) {
      case 'noteOn':
        s.noteOn(ev.id, ev.note, ev.velocity);
        break;
      case 'noteOff':
        s.noteOff(ev.id);
        break;
      case 'sustain':
        s.setSustain(ev.on);
        break;
      case 'bend':
        s.setPitchBend(ev.value);
        break;
      case 'allNotesOff':
        s.allNotesOff();
        break;
      case 'param': {
        const fromFrame = Math.round(Math.max(0, ev.time) * this.sampleRate);
        const toFrame = Math.round(ev.toTime * this.sampleRate);
        this.applyParam(ev.key, ev.fromValue);
        if (toFrame > fromFrame) this.ramps.set(ev.key, { fromFrame, fromValue: ev.fromValue, toFrame, toValue: ev.toValue, exp: ev.exp });
        else this.applyParam(ev.key, ev.toValue);
        break;
      }
    }
  }

  /**
   * Render one block. `blockStartFrame` is the absolute frame of outL[0]
   * (AudioWorkletGlobalScope.currentFrame). Output buffers are overwritten.
   */
  process(blockStartFrame: number, outL: Float32Array, outR: Float32Array): void {
    const len = outL.length;
    outL.fill(0);
    outR.fill(0);
    const blockEnd = blockStartFrame + len;
    let pos = 0;
    let consumed = 0;
    const q = this.queue;
    if (this.ramps.size) this.updateRamps(blockStartFrame);
    while (consumed < q.length) {
      const e = q[consumed] as QueuedEvent;
      if (e.frame >= blockEnd) break;
      const at = e.frame < 0 ? 0 : Math.max(0, e.frame - blockStartFrame);
      if (at > pos) {
        this.synth.render(outL, outR, pos, at - pos);
        pos = at;
      }
      this.apply(e.ev);
      consumed++;
    }
    if (consumed > 0) q.splice(0, consumed);
    if (pos < len) this.synth.render(outL, outR, pos, len - pos);
  }

  pendingEventCount(): number {
    return this.queue.length;
  }
}
