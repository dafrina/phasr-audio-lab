/**
 * AudioWorklet wrapper for CrushCore (the Saturator's Lo-Fi stage):
 * stereo in → sample-rate and bit-depth reduced stereo out. `bits` and
 * `rate` are AudioParams, so they can be automated.
 */
import { CrushCore } from '../saturator/CrushCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;

class CrushProcessor extends scope.AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 48000, minValue: 50, maxValue: 192000, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new CrushCore(scope.sampleRate);
  private alive = true;

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e: MessageEvent<{ type: 'dispose' }>) => {
      if (e.data.type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!out || !l) return this.alive;
    const input = inputs[0];
    this.core.process(input?.[0] ?? null, input?.[1] ?? null, l, out[1] ?? l, (params.bits?.[0] as number | undefined) ?? 16, (params.rate?.[0] as number | undefined) ?? scope.sampleRate);
    return this.alive;
  }
}

scope.registerProcessor('phasr-crush', CrushProcessor);
