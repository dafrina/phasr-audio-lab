/**
 * A send channel's audio: tracks' send taps → input → its effects (a shared
 * reverb / delay) → fader → mute → meter → master. Works in realtime and
 * offline (export) contexts.
 */
import type { SendBus } from '../project/types';
import { EffectChain } from './effectChain';
import { StereoMeter } from './meter';
import { dbToGainFader } from './trackChannel';

export class SendBusNode {
  readonly input: GainNode;
  readonly fx: EffectChain;
  readonly meter: StereoMeter;
  private readonly volume: GainNode;
  private readonly gate: GainNode;
  private readonly ctx: BaseAudioContext;

  /** what the channel outputs (post fader and mute, = what its meter shows), for analysers */
  get tap(): AudioNode {
    return this.gate;
  }

  constructor(ctx: BaseAudioContext, destination: AudioNode, realtime: boolean) {
    this.ctx = ctx;
    this.input = new GainNode(ctx);
    this.fx = new EffectChain(ctx, realtime);
    this.volume = new GainNode(ctx);
    this.gate = new GainNode(ctx);
    this.meter = new StereoMeter(ctx, realtime);
    this.input.connect(this.fx.input);
    this.fx.output.connect(this.volume);
    this.volume.connect(this.gate);
    this.gate.connect(destination);
    this.gate.connect(this.meter.input);
  }

  update(bus: SendBus, bpm: number, immediate = false): void {
    const t = this.ctx.currentTime;
    const vol = dbToGainFader(bus.volumeDb);
    const gate = bus.mute ? 0 : 1;
    if (immediate) {
      this.volume.gain.value = vol;
      this.gate.gain.value = gate;
    } else {
      this.volume.gain.setTargetAtTime(vol, t, 0.015);
      this.gate.gain.setTargetAtTime(gate, t, 0.015);
    }
    this.fx.sync(bus.effects, bpm);
  }

  dispose(): void {
    this.fx.dispose();
    this.input.disconnect();
    this.volume.disconnect();
    this.gate.disconnect();
  }
}

export { sendGain } from './sendGain';
