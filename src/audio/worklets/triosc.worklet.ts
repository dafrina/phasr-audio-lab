/**
 * AudioWorklet wrapper for TriOsc. All DSP lives in TriOscCore so the exact
 * same code renders in realtime, offline export and tests.
 *
 * processorOptions may include an initial `patch` and a list of `events`.
 * Offline rendering passes the full note list this way, because port messages
 * are delivered asynchronously and could arrive after rendering has begun.
 */
import { TriOscCore, type SynthEvent, type SynthMessage } from '../../synth/dsp/TriOscCore';
import { sanitizePatch } from '../../synth/params';

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

interface ProcessorOptions {
  patch?: unknown;
  events?: SynthEvent[];
}

class TriOscProcessor extends scope.AudioWorkletProcessor {
  private readonly core: TriOscCore;
  private alive = true;

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options);
    const opts = options?.processorOptions ?? {};
    this.core = new TriOscCore(scope.sampleRate, opts.patch ? sanitizePatch(opts.patch) : undefined);
    if (opts.events) this.core.handleMessage({ type: 'events', events: opts.events });
    this.port.onmessage = (e: MessageEvent<SynthMessage | { type: 'dispose' }>) => {
      const msg = e.data;
      if (msg.type === 'dispose') {
        this.alive = false;
        return;
      }
      this.core.handleMessage(msg);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out?.[0];
    if (!out || !l) return this.alive;
    const r = out[1] ?? l;
    this.core.process(scope.currentFrame, l, r);
    return this.alive;
  }
}

scope.registerProcessor('triosc', TriOscProcessor);
