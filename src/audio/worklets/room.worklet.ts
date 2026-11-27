/**
 * AudioWorklet wrapper for RoomCore (Reverb Lite): stereo in → reverb (wet)
 * stereo out. Decay, size and tone are AudioParams so automation and
 * sidechain routes can drive them.
 */
import { RoomCore } from '../room/RoomCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;

type InMsg = { type: 'dispose' };

class RoomProcessor extends scope.AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'decay', defaultValue: 1.6, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'decayShift', defaultValue: 0, minValue: -20, maxValue: 20, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 1, minValue: 0.3, maxValue: 1.6, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 6000, minValue: 200, maxValue: 20000, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new RoomCore(scope.sampleRate);
  private alive = true;

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      if (e.data.type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!out || !l) return this.alive;
    const r = out[1] ?? l;
    const input = inputs[0];
    const v = (k: string, d: number) => (params[k]?.[0] as number | undefined) ?? d;
    this.core.process(input?.[0] ?? null, input?.[1] ?? input?.[0] ?? null, l, r, {
      decay: v('decay', 1.6),
      decayShift: v('decayShift', 0),
      size: v('size', 1),
      tone: v('tone', 6000),
    });
    return this.alive;
  }
}

scope.registerProcessor('phasr-room', RoomProcessor);
