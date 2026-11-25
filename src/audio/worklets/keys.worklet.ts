/**
 * AudioWorklet wrapper for Keyforge. All DSP lives in KeysCore/KeysSynth so
 * realtime playback, offline export and tests run identical code.
 *
 * processorOptions: initial `config` ({ engine, params }) and `events`
 * (offline export passes the whole note list up front).
 */
import type { SynthEvent } from '../../synth/dsp/TriOscCore';
import { KeysCore, type KeysMessage } from '../../keys/dsp/KeysCore';
import type { KeysConfigData } from '../../keys/params';

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
  config?: KeysConfigData;
  events?: SynthEvent[];
}

class KeysProcessor extends scope.AudioWorkletProcessor {
  private readonly core: KeysCore;
  private alive = true;

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super(options);
    const opts = options?.processorOptions ?? {};
    this.core = new KeysCore(scope.sampleRate, opts.config);
    if (opts.events) this.core.handleMessage({ type: 'events', events: opts.events });
    this.port.onmessage = (e: MessageEvent<KeysMessage | { type: 'dispose' }>) => {
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

scope.registerProcessor('phasr-keys', KeysProcessor);
