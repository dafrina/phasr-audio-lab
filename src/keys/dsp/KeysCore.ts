/**
 * Sample-accurate event handling around KeysSynth (same contract as
 * TriOscCore): AudioContext-time events are converted to frames and each
 * render block is split at every event; automation arrives as 'param'
 * segments that ramp a flat parameter key.
 */
import type { SynthEvent } from '../../synth/dsp/TriOscCore';
import type { KeysConfigData } from '../params';
import { KeysSynth } from './KeysSynth';
import { PITCH_BEND_KEY } from '../../synth/dsp/bend';

export type KeysMessage =
  | SynthEvent
  | { type: 'events'; events: SynthEvent[] }
  | { type: 'cancel'; time: number }
  | { type: 'panic' }
  | { type: 'config'; config: KeysConfigData }
  | { type: 'autoKeys'; keys: string[] }
  | { type: 'autoValue'; key: string; value: number }
  | { type: 'tempo'; bpm: number };

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

export class KeysCore {
  readonly synth: KeysSynth;
  private readonly sampleRate: number;
  private queue: QueuedEvent[] = [];
  private readonly ramps = new Map<string, Ramp>();
  private readonly autoValues = new Map<string, number>();
  private autoKeys = new Set<string>();

  constructor(sampleRate: number, config?: KeysConfigData) {
    this.sampleRate = sampleRate;
    this.synth = new KeysSynth(sampleRate, config);
  }

  private applyParam(key: string, value: number): void {
    if (key === PITCH_BEND_KEY) {
      this.autoValues.set(key, value);
      this.synth.setPitchBend(Math.max(-1, Math.min(1, value)));
      return;
    }
    if (this.synth.setParam(key, value)) this.autoValues.set(key, value);
  }

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
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((q[mid] as QueuedEvent).frame <= frame) lo = mid + 1;
      else hi = mid;
    }
    q.splice(lo, 0, { frame, ev });
  }

  handleMessage(msg: KeysMessage): void {
    switch (msg.type) {
      case 'config': {
        const params = { ...msg.config.params };
        // parameters owned by automation keep their automated value
        for (const k of this.autoKeys) {
          const v = this.autoValues.get(k);
          if (v !== undefined && k in params) params[k] = v;
        }
        this.synth.setConfig({ engine: msg.config.engine, params });
        break;
      }
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
      case 'tempo':
        this.synth.setTempo(msg.bpm);
        break;
      case 'panic':
        this.queue = [];
        this.synth.panic();
        break;
      case 'cancel': {
        const f = this.toFrame(msg.time);
        this.queue = f < 0 ? [] : this.queue.filter((e) => e.frame < f);
        this.ramps.clear();
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

  /** Render one block starting at absolute frame `blockStartFrame`; outputs are overwritten. */
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
