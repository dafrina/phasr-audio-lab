/**
 * Main-thread handle for a TriOsc AudioWorkletNode. It only posts messages;
 * all synthesis happens in the worklet.
 */
import type { SynthEvent, SynthMessage } from '../synth/dsp/TriOscCore';
import type { TriOscPatch } from '../synth/params';

export const TRIOSC_PROCESSOR = 'triosc';

export class TriOscInstrument {
  readonly node: AudioWorkletNode;

  /** Audio output (same node; part of the shared instrument interface). */
  get output(): AudioNode {
    return this.node;
  }
  private patch: TriOscPatch;
  private disposed = false;

  constructor(ctx: BaseAudioContext, patch: TriOscPatch, events?: SynthEvent[]) {
    this.patch = patch;
    this.node = new AudioWorkletNode(ctx, TRIOSC_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { patch, events: events ?? [] },
    });
    // a processor that throws goes silent; make that visible instead of failing quietly
    this.node.onprocessorerror = () => console.error('TriOsc processor error — the instrument stopped producing sound.');
  }

  private post(msg: SynthMessage): void {
    if (!this.disposed) this.node.port.postMessage(msg);
  }

  setPatch(patch: TriOscPatch): void {
    if (patch === this.patch) return;
    this.patch = patch;
    this.post({ type: 'patch', patch });
  }

  schedule(events: SynthEvent[]): void {
    if (events.length) this.post({ type: 'events', events });
  }

  noteOn(id: number, note: number, velocity: number, time = -1): void {
    this.post({ type: 'noteOn', time, id, note, velocity });
  }

  noteOff(id: number, time = -1): void {
    this.post({ type: 'noteOff', time, id });
  }

  sustain(on: boolean, time = -1): void {
    this.post({ type: 'sustain', time, on });
  }

  pitchBend(value: number, time = -1): void {
    this.post({ type: 'bend', time, value });
  }

  setAutomatedKeys(keys: string[]): void {
    this.post({ type: 'autoKeys', keys });
  }

  setAutomationValue(key: string, value: number): void {
    this.post({ type: 'autoValue', key, value });
  }

  /** Drop everything scheduled at/after `time` and release sounding notes there. */
  cancel(time: number): void {
    this.post({ type: 'cancel', time });
  }

  allNotesOff(time = -1): void {
    this.post({ type: 'allNotesOff', time });
  }

  panic(): void {
    this.post({ type: 'panic' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.post({ type: 'panic' });
    this.node.port.postMessage({ type: 'dispose' });
    this.disposed = true;
    this.node.disconnect();
  }
}
