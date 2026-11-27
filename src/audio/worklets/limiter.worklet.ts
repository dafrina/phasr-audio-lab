/**
 * AudioWorklet wrapper for LimiterCore (the Limiter effect). k-rate params:
 * ceiling (dBFS), release (s), lookahead (ms; a change restarts the limiter).
 * Realtime only (processorOptions.meter): posts the gain reduction (dB, ≤ 0)
 * about 30 times a second while it changes, for the UI meter.
 */
import { LimiterCore } from '../limiter/LimiterCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;
const METER_BLOCKS = 12; // ≈ 32 ms at 48 kHz

class LimiterProcessor extends scope.AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -1, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' },
      { name: 'lookahead', defaultValue: 3, minValue: 0.5, maxValue: 10, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new LimiterCore(scope.sampleRate, 10);
  private readonly meter: boolean;
  private blocks = 0;
  private lastDb = 0;
  private alive = true;

  constructor(options?: { processorOptions?: { meter?: boolean } }) {
    super(options);
    this.meter = options?.processorOptions?.meter === true;
    this.port.onmessage = (e: MessageEvent<{ type: 'dispose' }>) => {
      if (e.data.type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!out || !l) return this.alive;
    const input = inputs[0];
    this.core.setLookahead((params.lookahead?.[0] as number | undefined) ?? 3);
    const ceiling = Math.pow(10, ((params.ceiling?.[0] as number | undefined) ?? -1) / 20);
    this.core.process(input?.[0] ?? null, input?.[1] ?? null, l, out[1] ?? null, l.length, ceiling, (params.release?.[0] as number | undefined) ?? 0.1);
    if (this.meter && ++this.blocks >= METER_BLOCKS) {
      this.blocks = 0;
      const g = this.core.takeMinGain();
      const db = g < 0.99999 ? 20 * Math.log10(g) : 0;
      if (Math.abs(db - this.lastDb) > 0.05) {
        this.lastDb = db;
        this.port.postMessage(db);
      }
    }
    return this.alive;
  }
}

scope.registerProcessor('phasr-limiter', LimiterProcessor);
