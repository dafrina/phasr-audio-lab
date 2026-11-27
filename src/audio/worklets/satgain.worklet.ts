/**
 * AudioWorklet wrapper for AutoGainCore (the Saturator's auto gain):
 * input 0 = the saturated signal, input 1 = the dry reference; output = the
 * saturated signal at the dry signal's level (or unchanged with auto off).
 */
import { AutoGainCore } from '../saturator/AutoGainCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;

class SatGainProcessor extends scope.AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'auto', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'guess', defaultValue: 1, minValue: 0, maxValue: 8, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new AutoGainCore(scope.sampleRate);
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
    const r = out[1] ?? l;
    const wet = inputs[0];
    const ref = inputs[1];
    this.core.process(wet?.[0] ?? null, wet?.[1] ?? null, ref?.[0] ?? null, ref?.[1] ?? null, l, r, ((params.auto?.[0] as number | undefined) ?? 1) >= 0.5, (params.guess?.[0] as number | undefined) ?? 1);
    return this.alive;
  }
}

scope.registerProcessor('phasr-satgain', SatGainProcessor);
