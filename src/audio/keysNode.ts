/**
 * Main-thread handle for a Keyforge AudioWorkletNode (messages only; the
 * synthesis runs in the worklet).
 */
import type { KeysMessage } from '../keys/dsp/KeysCore';
import type { KeysConfigData, KeysEngineType } from '../keys/params';
import type { SynthEvent } from '../synth/dsp/TriOscCore';
import type { InstrumentNode } from './instruments';

export const KEYS_PROCESSOR = 'phasr-keys';

export class KeysInstrument implements InstrumentNode {
  readonly node: AudioWorkletNode;
  private engine: KeysEngineType;
  private params: Record<string, number>;
  private disposed = false;

  get output(): AudioNode {
    return this.node;
  }

  constructor(ctx: BaseAudioContext, config: KeysConfigData, events?: SynthEvent[]) {
    this.engine = config.engine;
    this.params = config.params;
    this.node = new AudioWorkletNode(ctx, KEYS_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { config: { engine: config.engine, params: config.params }, events: events ?? [] },
    });
    this.node.onprocessorerror = () => console.error('Keyforge processor error — the instrument stopped producing sound.');
  }

  private post(msg: KeysMessage): void {
    if (!this.disposed) this.node.port.postMessage(msg);
  }

  setConfig(config: KeysConfigData): void {
    if (config.engine === this.engine && config.params === this.params) return;
    this.engine = config.engine;
    this.params = config.params;
    this.post({ type: 'config', config: { engine: config.engine, params: config.params } });
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
