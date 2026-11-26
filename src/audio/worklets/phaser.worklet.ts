/**
 * AudioWorklet wrapper for PhaserCore: stereo in → phased (wet) stereo out.
 * Parameters are AudioParams so automation and sidechain routes can drive
 * them; the stage count comes as a message.
 */
import { PhaserCore } from '../phaser/PhaserCore';

interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  sampleRate: number;
}
const scope = globalThis as unknown as WorkletScope;

type InMsg = { type: 'stages'; stages: number } | { type: 'dispose' };

class PhaserProcessor extends scope.AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.3, minValue: 0.01, maxValue: 30, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 2, minValue: 0, maxValue: 5, automationRate: 'k-rate' },
      { name: 'center', defaultValue: 700, minValue: 20, maxValue: 18000, automationRate: 'k-rate' },
      { name: 'shift', defaultValue: 0, minValue: -10, maxValue: 10, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: -0.95, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'stereo', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  private readonly core: PhaserCore;
  private alive = true;

  constructor(options?: { processorOptions?: { stages?: number } }) {
    super(options);
    this.core = new PhaserCore(scope.sampleRate, options?.processorOptions?.stages ?? 6);
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      if (e.data.type === 'stages') this.core.setStages(e.data.stages);
      else if (e.data.type === 'dispose') this.alive = false;
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
      rate: v('rate', 0.3),
      depth: v('depth', 2),
      center: v('center', 700),
      shift: v('shift', 0),
      feedback: v('feedback', 0.5),
      stereo: v('stereo', 0.5),
    });
    return this.alive;
  }
}

scope.registerProcessor('phasr-phaser', PhaserProcessor);
