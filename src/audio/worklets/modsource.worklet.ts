/**
 * AudioWorklet wrapper for ModSourceCore. Output: one channel of 0..1 control
 * signal that the engine routes (through depth gains) into target AudioParams.
 *
 * processorOptions: { settings, triggers?: number[] (context times) } —
 * offline rendering passes all MIDI trigger times up front.
 */
import { ModSourceCore, type ModSettings } from '../modsource/ModSourceCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
  currentFrame: number;
}
const scope = globalThis as unknown as WorkletScope;

type InMsg =
  | { type: 'settings'; settings: ModSettings }
  | { type: 'triggers'; times: number[] }
  | { type: 'cancel'; time: number }
  | { type: 'dispose' };

class ModSourceProcessor extends scope.AudioWorkletProcessor {
  private readonly core: ModSourceCore;
  private alive = true;

  constructor(options?: { processorOptions?: { settings: ModSettings; triggers?: number[] } }) {
    super(options);
    const o = options?.processorOptions;
    this.core = new ModSourceCore(scope.sampleRate, o?.settings ?? { mode: 'audio', attack: 0.005, release: 0.15, threshold: -30, hold: 0, invert: false });
    for (const t of o?.triggers ?? []) this.core.trigger(this.toFrame(t));
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      const m = e.data;
      if (m.type === 'settings') this.core.setSettings(m.settings);
      else if (m.type === 'triggers') for (const t of m.times) this.core.trigger(this.toFrame(t));
      else if (m.type === 'cancel') this.core.cancel(this.toFrame(m.time));
      else if (m.type === 'dispose') this.alive = false;
    };
  }

  private toFrame(time: number): number {
    return time < 0 ? -1 : Math.round(time * scope.sampleRate);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return this.alive;
    const input = inputs[0];
    this.core.process(scope.currentFrame, input?.[0] ?? null, input?.[1] ?? null, out);
    return this.alive;
  }
}

scope.registerProcessor('phasr-modsource', ModSourceProcessor);
