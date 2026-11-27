/**
 * Insert effect units built from native Web Audio nodes, so they run in both
 * the realtime AudioContext and an OfflineAudioContext (WAV export).
 *
 * Every unit is wrapped in a click-free bypass: input feeds both a dry path
 * and the processing path, and enabling/disabling crossfades the two.
 * All parameter changes use setTargetAtTime smoothing to avoid zipper noise.
 */
import { dbToGain } from '../../core/ids';
import type { AutoFilterMode, AutoFilterParams, PhaserParams, RoomParams, SaturatorMode, SaturatorParams, UtilityParams, ChorusParams, CompressorParams, DelayParams, EffectSlot, EffectType, EqParams, LimiterParams, PeqBand, PeqParams, ReverbParams } from '../../project/types';
import { parseBandKey } from '../../project/automation';
import { generateImpulse } from './impulse';
import { SAT_RANGE, saturatorCurve, saturatorGain } from '../saturator/shapes';
import { MAX_DELAY_SECONDS, PEQ_BANDS, autoFilterLfoHz, delayTimeSeconds, mixGains, phaserLfoHz, saturatorCrushOn } from './specs';

const SMOOTH = 0.02;
const EQ_LOW_FREQ = 220;
const EQ_HIGH_FREQ = 4500;
const EQ_MID_Q = 0.8;

/** An AudioParam an automation lane drives, with the value → param mapping. */
export interface ParamTarget {
  param: AudioParam;
  map: (v: number) => number;
  /** ramp exponentially (frequencies) instead of linearly */
  exp?: boolean;
}

/** An AudioParam a modulation signal (0..1) is added to, with depth → gain scaling. */
export interface ModInput {
  param: AudioParam;
  scale: (depth: number) => number;
}

export interface EffectUnit {
  readonly id: string;
  readonly type: EffectType;
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Apply static settings. Keys in `automated` are owned by automation and left alone. */
  update(slot: EffectSlot, bpm: number, automated?: ReadonlySet<string>): void;
  automationParams(key: string): ParamTarget[];
  modulationInputs(key: string): ModInput[];
  dispose(): void;
}

const NONE: ReadonlySet<string> = new Set();
/** wet-level sidechain: depth in dB → gain offset at full envelope (gain = 1 + env·(10^(d/20) − 1)) */
const wetDuckScale = (d: number) => dbToGain(d) - 1;
const ident = (v: number) => v;

function setParam(p: AudioParam, v: number, ctx: BaseAudioContext, immediate: boolean): void {
  if (immediate) {
    p.cancelScheduledValues(0);
    p.value = v;
  } else {
    p.setTargetAtTime(v, ctx.currentTime, SMOOTH);
  }
}

/** Live sidechain offset of one EQ band (dB, cents, Q units) for drawing its response. */
export interface PeqBandOffset {
  gain?: number;
  cents?: number;
  q?: number;
}

/** Shared bypass wrapper around a processing section [procIn → procOut]. */
abstract class BaseUnit implements EffectUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  protected readonly dry: GainNode;
  protected readonly wet: GainNode;
  /** where the processing starts; cut off from the input while the effect is switched off */
  protected readonly src: GainNode;
  private srcConnected = true;
  private offTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly ctx: BaseAudioContext;
  protected initialized = false;
  abstract readonly type: EffectType;
  readonly id: string;
  private enabled = true;

  constructor(ctx: BaseAudioContext, id: string) {
    this.ctx = ctx;
    this.id = id;
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    this.dry = new GainNode(ctx, { gain: 0 });
    this.wet = new GainNode(ctx, { gain: 1 });
    this.src = new GainNode(ctx);
    this.input.connect(this.dry);
    this.input.connect(this.src);
    this.dry.connect(this.output);
    this.wet.connect(this.output);
  }

  protected setEnabled(on: boolean): void {
    const immediate = !this.initialized;
    if (on === this.enabled && !immediate) return;
    this.enabled = on;
    if (this.offTimer) clearTimeout(this.offTimer);
    this.offTimer = null;
    if (on && !this.srcConnected) {
      this.input.connect(this.src);
      this.srcConnected = true;
    }
    setParam(this.wet.gain, on ? 1 : 0, this.ctx, immediate);
    setParam(this.dry.gain, on ? 0 : 1, this.ctx, immediate);
    if (!on) {
      // a switched-off effect does no work: its processing gets no input (silent nodes are skipped).
      // Realtime: after the crossfade and a moment for the wet tail to fade.
      const offAt = this.ctx.currentTime;
      const cut = () => {
        if (this.enabled || !this.srcConnected) return;
        // the crossfade runs on the audio clock: wait until it has really played (a suspended
        // context — not started yet, or interrupted by the system — doesn't advance meanwhile)
        if (!immediate && this.ctx.currentTime < offAt + 0.1) {
          this.offTimer = setTimeout(cut, 60);
          return;
        }
        this.input.disconnect(this.src);
        this.srcConnected = false;
        // Chromium doesn't advance a gain's automation while its branch is silent, so pin the
        // wet gain at its target; otherwise switching back on could fade in from a stale value
        this.wet.gain.cancelScheduledValues(0);
        this.wet.gain.value = 0;
      };
      if (immediate) cut();
      else this.offTimer = setTimeout(cut, 120);
    }
  }

  abstract update(slot: EffectSlot, bpm: number, automated?: ReadonlySet<string>): void;
  abstract automationParams(key: string): ParamTarget[];

  modulationInputs(_key: string): ModInput[] {
    return [];
  }

  dispose(): void {
    if (this.offTimer) clearTimeout(this.offTimer);
    this.input.disconnect();
    this.src.disconnect();
    this.dry.disconnect();
    this.wet.disconnect();
    this.output.disconnect();
  }
}

class EqUnit extends BaseUnit {
  readonly type = 'eq' as const;
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: EQ_LOW_FREQ });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: EQ_MID_Q });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: EQ_HIGH_FREQ });
    this.src.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.wet);
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'eq') return;
    const p: EqParams = slot.params;
    const im = !this.initialized;
    if (!auto.has('lowGain')) setParam(this.low.gain, p.lowGain, this.ctx, im);
    if (!auto.has('midGain')) setParam(this.mid.gain, p.midGain, this.ctx, im);
    if (!auto.has('midFreq')) setParam(this.mid.frequency, p.midFreq, this.ctx, im);
    if (!auto.has('highGain')) setParam(this.high.gain, p.highGain, this.ctx, im);
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'lowGain':
        return [{ param: this.low.gain, map: ident }];
      case 'midGain':
        return [{ param: this.mid.gain, map: ident }];
      case 'midFreq':
        return [{ param: this.mid.frequency, map: ident, exp: true }];
      case 'highGain':
        return [{ param: this.high.gain, map: ident }];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    switch (key) {
      case 'lowGain':
        return [{ param: this.low.gain, scale: ident }];
      case 'midGain':
        return [{ param: this.mid.gain, scale: ident }];
      case 'highGain':
        return [{ param: this.high.gain, scale: ident }];
      case 'midFreq':
        return [{ param: this.mid.detune, scale: (d) => d * 100 }]; // semitones → cents
      default:
        return [];
    }
  }

  override dispose(): void {
    super.dispose();
    this.low.disconnect();
    this.mid.disconnect();
    this.high.disconnect();
  }
}

/**
 * The Web Audio DynamicsCompressorNode applies its own automatic makeup gain
 * of (1 / fullRangeGain)^0.6, where fullRangeGain is the compression curve
 * evaluated at 0 dBFS. We cancel it so Threshold/Ratio/Makeup behave like a
 * conventional compressor (makeup = what the knob says). Knee is ignored in
 * the estimate; the residual error is under ~1 dB with the fixed 6 dB knee.
 */
export function autoMakeupCompensationDb(threshold: number, ratio: number): number {
  const fullRangeGainDb = threshold * (1 - 1 / ratio); // ≤ 0
  return 0.6 * fullRangeGainDb;
}

/** The master's safety limiter (playback and export): hard knee, just under 0 dBFS. */
export const SAFETY_LIMITER = { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.12 } as const;

/**
 * The master's safety limiter: SAFETY_LIMITER's DynamicsCompressorNode and a
 * gain cancelling the node's automatic makeup (+0.57 dB at these settings —
 * exact for a hard knee), so it changes nothing below its threshold.
 */
export function createSafetyLimiter(ctx: BaseAudioContext): { input: DynamicsCompressorNode; output: GainNode } {
  const input = new DynamicsCompressorNode(ctx, SAFETY_LIMITER);
  const output = new GainNode(ctx, { gain: dbToGain(autoMakeupCompensationDb(SAFETY_LIMITER.threshold, SAFETY_LIMITER.ratio)) });
  input.connect(output);
  return { input, output };
}

/**
 * Utility: gain → per-channel polarity → mid/side width matrix → balance.
 * Four gains do the width (L' = M + w·S, R' = M − w·S, folded into
 * L/R → L'/R' coefficients), so width ramps smoothly under automation; a
 * StereoPannerNode does the balance. Nearly free.
 */
class UtilityUnit extends BaseUnit {
  readonly type = 'utility' as const;
  private readonly gain: GainNode;
  private readonly duck: GainNode;
  private readonly split: ChannelSplitterNode;
  private readonly ll: GainNode;
  private readonly lr: GainNode;
  private readonly rl: GainNode;
  private readonly rr: GainNode;
  private readonly merge: ChannelMergerNode;
  private readonly pan: StereoPannerNode;
  private invL = 1;
  private invR = 1;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.gain = new GainNode(ctx);
    this.duck = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' });
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.ll = new GainNode(ctx);
    this.lr = new GainNode(ctx, { gain: 0 });
    this.rl = new GainNode(ctx, { gain: 0 });
    this.rr = new GainNode(ctx);
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.pan = new StereoPannerNode(ctx);
    this.src.connect(this.gain);
    this.gain.connect(this.duck);
    this.duck.connect(this.split);
    this.split.connect(this.ll, 0);
    this.split.connect(this.lr, 0);
    this.split.connect(this.rl, 1);
    this.split.connect(this.rr, 1);
    this.ll.connect(this.merge, 0, 0);
    this.rl.connect(this.merge, 0, 0);
    this.lr.connect(this.merge, 0, 1);
    this.rr.connect(this.merge, 0, 1);
    this.merge.connect(this.pan);
    this.pan.connect(this.wet);
  }

  /** width w → the four matrix gains (with polarity) */
  private matrix(w: number): { ll: number; lr: number; rl: number; rr: number } {
    const a = 0.5 * (1 + w);
    const b = 0.5 * (1 - w);
    return { ll: a * this.invL, lr: b * this.invL, rl: b * this.invR, rr: a * this.invR };
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'utility') return;
    const p: UtilityParams = slot.params;
    const im = !this.initialized;
    this.invL = p.invertL ? -1 : 1;
    this.invR = p.invertR ? -1 : 1;
    if (!auto.has('gain')) setParam(this.gain.gain, dbToGain(p.gain), this.ctx, im);
    if (!auto.has('pan')) setParam(this.pan.pan, p.pan, this.ctx, im);
    if (!auto.has('width')) {
      const m = this.matrix(p.width);
      setParam(this.ll.gain, m.ll, this.ctx, im);
      setParam(this.lr.gain, m.lr, this.ctx, im);
      setParam(this.rl.gain, m.rl, this.ctx, im);
      setParam(this.rr.gain, m.rr, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'gain':
        return [{ param: this.gain.gain, map: (v) => dbToGain(v) }];
      case 'pan':
        return [{ param: this.pan.pan, map: (v) => Math.max(-1, Math.min(1, v)) }];
      case 'width':
        return [
          { param: this.ll.gain, map: (v) => this.matrix(v).ll },
          { param: this.lr.gain, map: (v) => this.matrix(v).lr },
          { param: this.rl.gain, map: (v) => this.matrix(v).rl },
          { param: this.rr.gain, map: (v) => this.matrix(v).rr },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'gain') return [{ param: this.duck.gain, scale: wetDuckScale }];
    return [];
  }

  override dispose(): void {
    super.dispose();
    for (const n of [this.gain, this.duck, this.split, this.ll, this.lr, this.rl, this.rr, this.merge, this.pan]) n.disconnect();
  }
}

/** a 4× oversampled WaveShaperNode delays its output by this many samples (measured in Chromium) */
const SAT_OS_LATENCY = 192;
const satCurves = new Map<SaturatorMode, Float32Array<ArrayBuffer>>();
const satCurve = (m: SaturatorMode) => {
  let c = satCurves.get(m);
  if (!c) satCurves.set(m, (c = saturatorCurve(m)));
  return c;
};

/**
 * Saturator (saturation → distortion → fuzz):
 *
 *   src ─┬─ low-pass (clean <) ─ delay ─┬──────────────────────────── (clean lows) ─┐
 *        │                              │                                          wet blend ─┐
 *        └─ high-pass (clean <) ─┬ emphasis + → drive (+ bias) → WaveShaper 4× → [Lo-Fi]      │
 *                                │   → DC block → emphasis − → tone → auto gain ──┘            ├→ output
 *                                └ delay ─┬→ (auto gain's reference)                           │
 *                                         └─────────────── + lows ───────── dry blend ─────────┘
 *
 * The WaveShaper is 4× oversampled (the added harmonics don't alias); every
 * path that skips it is delayed by its latency, so splits and blends stay in
 * phase. Below "Clean <" the signal bypasses the distortion (kick and sub stay
 * solid; Linkwitz-Riley split, so the bands sum flat). The emphasis boosts a
 * band before the drive and takes it out again after: the distortion
 * concentrates there without changing the EQ. Bias shifts the curve off
 * centre (even harmonics). Drive is a plain gain in front of a curve that
 * covers ±64 (see shapes.ts), so it ramps smoothly under automation. Auto
 * gain measures the dry and saturated levels and matches them
 * (AutoGainCore). The Lo-Fi stage (worklet) is only wired in while it
 * changes the sound.
 */
class SaturatorUnit extends BaseUnit {
  readonly type = 'saturator' as const;
  private readonly lowA: BiquadFilterNode;
  private readonly lowB: BiquadFilterNode;
  private readonly lowDelay: DelayNode;
  private readonly lowGain: GainNode;
  private readonly highA: BiquadFilterNode;
  private readonly highB: BiquadFilterNode;
  private readonly emphPre: BiquadFilterNode;
  private readonly emphPost: BiquadFilterNode;
  private readonly pre: GainNode;
  private readonly bias: ConstantSourceNode;
  private readonly shaper: WaveShaperNode;
  private crush: AudioWorkletNode | null = null;
  private readonly dcBlock: BiquadFilterNode;
  private readonly tone: BiquadFilterNode;
  /** auto gain: matches the saturated signal's level to the dry one (phasr-satgain worklet) */
  private readonly comp: AudioWorkletNode;
  private readonly refDelay: DelayNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private readonly out: GainNode;
  private readonly outDuck: GainNode;
  private mode: SaturatorMode | null = null;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    const lat = SAT_OS_LATENCY / ctx.sampleRate;
    // (Web Audio reads a low/high-pass Q in dB: −3.01 dB = 1/√2, Butterworth)
    const lr = (type: BiquadFilterType) => new BiquadFilterNode(ctx, { type, frequency: 20, Q: -3.01 });
    // clean-low split (Linkwitz-Riley: two Butterworth stages per side)
    this.lowA = lr('lowpass');
    this.lowB = lr('lowpass');
    this.lowDelay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: lat });
    this.lowGain = new GainNode(ctx);
    this.highA = lr('highpass');
    this.highB = lr('highpass');
    this.emphPre = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1200, Q: 0.9, gain: 0 });
    this.emphPost = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1200, Q: 0.9, gain: 0 });
    this.pre = new GainNode(ctx);
    this.bias = new ConstantSourceNode(ctx, { offset: 0 });
    this.shaper = new WaveShaperNode(ctx, { oversample: '4x' });
    this.dcBlock = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 8, Q: -3.01 });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: -3.01 });
    this.comp = new AudioWorkletNode(ctx, 'phasr-satgain', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.refDelay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: lat });
    this.dGain = new GainNode(ctx, { gain: 0 });
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.out = new GainNode(ctx);
    this.outDuck = new GainNode(ctx, { gain: 1 });
    // fixed connections; the optional stages (split, emphasis, bias, Lo-Fi) are wired by rewire()
    this.lowA.connect(this.lowB);
    this.lowB.connect(this.lowDelay);
    this.highA.connect(this.highB);
    this.lowGain.connect(this.wGain);
    this.pre.connect(this.shaper);
    this.bias.start();
    this.tone.connect(this.comp);
    this.comp.connect(this.wGain);
    // the auto gain's reference: the distorted band, dry, aligned with the oversampler
    this.refDelay.connect(this.comp, 0, 1);
    // dry blend: the band(s) re-joined (the split sums flat, with the same phase as the wet path)
    this.refDelay.connect(this.dGain);
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.out);
    this.dGain.connect(this.out);
    this.out.connect(this.outDuck);
    this.outDuck.connect(this.wet);
    this.rewire(false, false, false, false);
  }

  private wiring = '';

  /**
   * Wire only the stages in use, so a plain setting costs what a plain saturator does:
   * split (clean lows), emphasis (pre / post), bias, Lo-Fi.
   */
  private rewire(split: boolean, emph: boolean, bias: boolean, crush: boolean): void {
    const key = `${+split}${+emph}${+bias}${+crush}`;
    if (key === this.wiring) return;
    this.wiring = key;
    if (crush) this.crush ??= new AudioWorkletNode(this.ctx, 'phasr-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    for (const n of [this.src, this.highB, this.lowDelay, this.emphPre, this.shaper, this.dcBlock, this.emphPost, this.bias]) n.disconnect();
    this.crush?.disconnect();
    // the band that gets distorted: everything, or what's above the split
    let band: AudioNode = this.src;
    if (split) {
      this.src.connect(this.lowA);
      this.src.connect(this.highA);
      this.lowDelay.connect(this.lowGain);
      this.lowDelay.connect(this.dGain);
      band = this.highB;
    }
    band.connect(this.refDelay);
    if (emph) {
      band.connect(this.emphPre);
      this.emphPre.connect(this.pre);
    } else band.connect(this.pre);
    if (bias) this.bias.connect(this.shaper);
    let at: AudioNode = this.shaper;
    if (crush && this.crush) {
      at.connect(this.crush);
      at = this.crush;
    }
    at.connect(this.dcBlock);
    if (emph) {
      this.dcBlock.connect(this.emphPost);
      this.emphPost.connect(this.tone);
    } else this.dcBlock.connect(this.tone);
  }

  /** the auto gain's starting point (a static estimate) before it has measured the levels */
  private compGain(driveDb: number): number {
    return this.mode ? 1 / saturatorGain(this.mode, driveDb) : 1;
  }

  private compParam(name: 'auto' | 'guess'): AudioParam {
    return this.comp.parameters.get(name) as AudioParam;
  }

  private crushParam(name: 'bits' | 'rate'): AudioParam | null {
    return (this.crush?.parameters.get(name) as AudioParam | undefined) ?? null;
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'saturator') return;
    const p: SaturatorParams = slot.params;
    const im = !this.initialized;
    const nyq = this.ctx.sampleRate * 0.45;
    if (p.mode !== this.mode) {
      this.mode = p.mode;
      this.shaper.curve = satCurve(p.mode);
    }
    this.compParam('auto').value = p.autoGain ? 1 : 0;
    if (!auto.has('drive')) {
      setParam(this.pre.gain, dbToGain(p.drive) / SAT_RANGE, this.ctx, im);
      this.compParam('guess').value = this.compGain(p.drive);
    }
    const splitOn = p.clean > 20.5;
    const emphOn = p.emph > 0.05;
    const biasOn = p.bias > 0.005;
    this.rewire(splitOn, emphOn, biasOn, saturatorCrushOn(p) || auto.has('bits') || auto.has('rate'));
    setParam(this.bias.offset, p.bias / SAT_RANGE, this.ctx, im);
    // clean lows: split at `clean`
    for (const n of [this.lowA, this.lowB, this.highA, this.highB]) setParam(n.frequency, Math.max(20, p.clean), this.ctx, im);
    for (const n of [this.emphPre, this.emphPost]) setParam(n.frequency, Math.min(nyq, p.focus), this.ctx, im);
    setParam(this.emphPre.gain, p.emph, this.ctx, im);
    setParam(this.emphPost.gain, -p.emph, this.ctx, im);
    const bits = this.crushParam('bits');
    const rate = this.crushParam('rate');
    if (bits && !auto.has('bits')) setParam(bits, p.bits, this.ctx, im);
    if (rate && !auto.has('rate')) setParam(rate, p.rate >= 39900 ? this.ctx.sampleRate : p.rate, this.ctx, im);
    if (!auto.has('tone')) setParam(this.tone.frequency, Math.min(nyq, p.tone), this.ctx, im);
    if (!auto.has('output')) setParam(this.out.gain, dbToGain(p.output), this.ctx, im);
    if (!auto.has('mix')) {
      setParam(this.dGain.gain, 1 - p.mix, this.ctx, im);
      setParam(this.wGain.gain, p.mix, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'drive':
        return [{ param: this.pre.gain, map: (v) => dbToGain(Math.max(0, v)) / SAT_RANGE }];
      case 'tone':
        return [{ param: this.tone.frequency, map: (v) => Math.min(this.ctx.sampleRate * 0.45, Math.max(20, v)), exp: true }];
      case 'output':
        return [{ param: this.out.gain, map: (v) => dbToGain(v) }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => 1 - v },
          { param: this.wGain.gain, map: (v) => v },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    // output in dB: a kick can pump the saturated signal
    if (key === 'output') return [{ param: this.outDuck.gain, scale: wetDuckScale }];
    return [];
  }

  override dispose(): void {
    super.dispose();
    this.comp.port.postMessage({ type: 'dispose' });
    this.crush?.port.postMessage({ type: 'dispose' });
    try {
      this.bias.stop();
    } catch {
      // already stopped
    }
    for (const n of [this.lowA, this.lowB, this.lowDelay, this.lowGain, this.highA, this.highB, this.emphPre, this.emphPost, this.pre, this.bias, this.shaper, this.dcBlock, this.tone, this.comp, this.refDelay, this.dGain, this.wGain, this.wetDuck, this.out, this.outDuck]) n.disconnect();
    this.crush?.disconnect();
  }
}

class CompressorUnit extends BaseUnit {
  readonly type = 'compressor' as const;
  private readonly comp: DynamicsCompressorNode;
  private readonly makeup: GainNode;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.comp = new DynamicsCompressorNode(ctx, { knee: 6 });
    this.makeup = new GainNode(ctx);
    this.src.connect(this.comp);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.wet);
  }

  private staticComp = { threshold: -18, ratio: 4 };

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'compressor') return;
    const p: CompressorParams = slot.params;
    const im = !this.initialized;
    this.staticComp = { threshold: p.threshold, ratio: p.ratio };
    if (!auto.has('threshold')) setParam(this.comp.threshold, p.threshold, this.ctx, im);
    if (!auto.has('ratio')) setParam(this.comp.ratio, p.ratio, this.ctx, im);
    if (!auto.has('attack')) setParam(this.comp.attack, p.attack, this.ctx, im);
    if (!auto.has('release')) setParam(this.comp.release, p.release, this.ctx, im);
    if (!auto.has('makeup')) setParam(this.makeup.gain, dbToGain(p.makeup + autoMakeupCompensationDb(p.threshold, p.ratio)), this.ctx, im);
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'threshold':
        return [{ param: this.comp.threshold, map: ident }];
      case 'ratio':
        return [{ param: this.comp.ratio, map: ident }];
      case 'attack':
        return [{ param: this.comp.attack, map: ident }];
      case 'release':
        return [{ param: this.comp.release, map: ident }];
      case 'makeup': {
        // compensation uses the static threshold/ratio (automating those shifts level slightly)
        const comp = autoMakeupCompensationDb(this.staticComp.threshold, this.staticComp.ratio);
        return [{ param: this.makeup.gain, map: (v) => dbToGain(v + comp) }];
      }
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    return key === 'threshold' ? [{ param: this.comp.threshold, scale: ident }] : [];
  }

  /** Current gain reduction in dB (≤ 0), for the UI meter. */
  reduction(): number {
    return this.comp.reduction;
  }

  override dispose(): void {
    super.dispose();
    this.comp.disconnect();
    this.makeup.disconnect();
  }
}

/**
 * Limiter: drive → (sidechain duck on the drive) → the phasr-limiter worklet
 * (LimiterCore: lookahead brickwall, the ceiling is never passed). The audio
 * is delayed by the lookahead while the limiter is on; switched off, the
 * bypass passes the input untouched (so the timing moves by the lookahead).
 * In the realtime context the worklet reports its gain reduction for the meter.
 */
class LimiterUnit extends BaseUnit {
  readonly type = 'limiter' as const;
  private readonly pre: GainNode;
  private readonly duck: GainNode;
  private readonly node: AudioWorkletNode;
  private gr = 0;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.pre = new GainNode(ctx);
    this.duck = new GainNode(ctx, { gain: 1 });
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    this.node = new AudioWorkletNode(ctx, 'phasr-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { meter: realtime },
    });
    if (realtime) this.node.port.onmessage = (e: MessageEvent<number>) => (this.gr = e.data);
    this.src.connect(this.pre);
    this.pre.connect(this.duck);
    this.duck.connect(this.node);
    this.node.connect(this.wet);
  }

  private param(name: 'ceiling' | 'release' | 'lookahead'): AudioParam {
    return this.node.parameters.get(name) as AudioParam;
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'limiter') return;
    const p: LimiterParams = slot.params;
    const im = !this.initialized;
    if (!auto.has('drive')) setParam(this.pre.gain, dbToGain(p.drive), this.ctx, im);
    if (!auto.has('ceiling')) setParam(this.param('ceiling'), p.ceiling, this.ctx, im);
    if (!auto.has('release')) setParam(this.param('release'), p.release, this.ctx, im);
    // a choice, not a sweep: set at once (a change restarts the limiter)
    const la = this.param('lookahead');
    if (la.value !== p.lookahead) {
      la.cancelScheduledValues(0);
      la.value = p.lookahead;
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'drive':
        return [{ param: this.pre.gain, map: (v) => dbToGain(v) }];
      case 'ceiling':
        return [{ param: this.param('ceiling'), map: (v) => Math.min(0, v) }];
      case 'release':
        return [{ param: this.param('release'), map: ident, exp: true }];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    return key === 'drive' ? [{ param: this.duck.gain, scale: wetDuckScale }] : [];
  }

  /** Current gain reduction in dB (≤ 0), for the UI meter (realtime only). */
  reduction(): number {
    return this.gr;
  }

  override dispose(): void {
    super.dispose();
    this.node.port.onmessage = null;
    this.node.port.postMessage({ type: 'dispose' });
    for (const n of [this.pre, this.duck, this.node]) n.disconnect();
  }
}

/**
 * Feedback delay: input → delay → wet mix; delay → damping LPF → feedback
 * gain → delay. The low-pass in the loop makes repeats darken naturally and
 * keeps high feedback settings from building harsh resonances.
 */
class DelayUnit extends BaseUnit {
  readonly type = 'delay' as const;
  private readonly delay: DelayNode;
  private readonly fb: GainNode;
  private readonly damp: BiquadFilterNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY_SECONDS });
    this.fb = new GainNode(ctx, { gain: 0 });
    // Q is in dB for Web Audio low-pass filters; -3 dB ≈ Butterworth (no overshoot that would add gain per repeat)
    this.damp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6500, Q: -3.01 });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.delay);
    this.delay.connect(this.wGain);
    // sidechain stage on the wet signal only ("ducked" reverb / delay / chorus)
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
    this.delay.connect(this.damp);
    this.damp.connect(this.fb);
    this.fb.connect(this.delay);
  }

  update(slot: EffectSlot, bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'delay') return;
    const p: DelayParams = slot.params;
    const im = !this.initialized;
    // a slightly slower glide on delay time gives a tape-like pitch bend instead of a click
    const t = delayTimeSeconds(p, bpm);
    if (!(auto.has('time') && !p.sync)) {
      if (im) this.delay.delayTime.value = t;
      else this.delay.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.05);
    }
    if (!auto.has('feedback')) setParam(this.fb.gain, Math.min(0.95, p.feedback), this.ctx, im);
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'time':
        return [{ param: this.delay.delayTime, map: (v) => Math.min(MAX_DELAY_SECONDS, Math.max(0.001, v)) }];
      case 'feedback':
        return [{ param: this.fb.gain, map: (v) => Math.min(0.95, v) }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'feedback') return [{ param: this.fb.gain, scale: ident }];
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    return [];
  }

  override dispose(): void {
    super.dispose();
    for (const n of [this.delay, this.fb, this.damp, this.dGain, this.wGain, this.wetDuck]) n.disconnect();
  }
}

/**
 * Reverb Pro: pre-delay → ConvolverNode (a generated stereo room impulse,
 * shaped by decay, size, damping and early reflections) → tail EQ (low cut,
 * high cut) → width → wet blend. The impulse is rebuilt when its shape
 * changes (debounced while a knob moves, with a short crossfade). The tail
 * EQ and width stages are only wired in while they change the sound (or are
 * automated), so the default path is exactly the convolver.
 */
class ReverbUnit extends BaseUnit {
  readonly type = 'reverb' as const;
  private readonly pre: DelayNode;
  private readonly dGain: GainNode;
  private readonly tailIn: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private branch: { conv: ConvolverNode; gain: GainNode } | null = null;
  /** the impulse currently built (decay|size|damping|early) */
  private irKey = '';
  private pendingIr: ReverbParams | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtime: boolean;
  private lowCut: BiquadFilterNode | null = null;
  private highCut: BiquadFilterNode | null = null;
  private widthStage: { split: ChannelSplitterNode; ll: GainNode; lr: GainNode; rl: GainNode; rr: GainNode; merge: ChannelMergerNode } | null = null;
  private tailWiring = '';

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.realtime = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.5 });
    this.dGain = new GainNode(ctx);
    this.tailIn = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.pre);
    // sidechain stage on the wet signal only ("ducked" reverb / delay / chorus)
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
    this.rewireTail(false, false, false);
  }

  private static irKeyOf(p: ReverbParams): string {
    return `${p.decay.toFixed(4)}|${p.size.toFixed(3)}|${p.damping.toFixed(3)}|${p.early.toFixed(3)}`;
  }

  private buildBranch(p: ReverbParams, fadeIn: boolean): void {
    const [l, r] = generateImpulse(this.ctx.sampleRate, p.decay, { size: p.size, damping: p.damping, early: p.early });
    const buf = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate: this.ctx.sampleRate });
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    const conv = new ConvolverNode(this.ctx, { buffer: buf, disableNormalization: false });
    const gain = new GainNode(this.ctx, { gain: fadeIn ? 0 : 1 });
    this.pre.connect(conv);
    conv.connect(gain);
    gain.connect(this.tailIn);
    const old = this.branch;
    this.branch = { conv, gain };
    this.irKey = ReverbUnit.irKeyOf(p);
    if (fadeIn) {
      const t = this.ctx.currentTime;
      gain.gain.setTargetAtTime(1, t, 0.03);
      if (old) {
        old.gain.gain.setTargetAtTime(0, t, 0.03);
        // let the old branch fade, then release it
        setTimeout(() => {
          this.pre.disconnect(old.conv);
          old.conv.disconnect();
          old.gain.disconnect();
        }, 400);
      }
    } else if (old) {
      this.pre.disconnect(old.conv);
      old.conv.disconnect();
      old.gain.disconnect();
    }
  }

  /** tailIn → [low cut] → [high cut] → [width] → wet gain, with only the stages in use */
  private rewireTail(lc: boolean, hc: boolean, w: boolean): void {
    const key = `${+lc}${+hc}${+w}`;
    if (key === this.tailWiring) return;
    this.tailWiring = key;
    const ctx = this.ctx;
    if (lc) this.lowCut ??= new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: -3.01 });
    if (hc) this.highCut ??= new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: -3.01 });
    if (w && !this.widthStage) {
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      const g = () => new GainNode(ctx, { gain: 0 });
      const st = { split, ll: g(), lr: g(), rl: g(), rr: g(), merge: new ChannelMergerNode(ctx, { numberOfInputs: 2 }) };
      split.connect(st.ll, 0);
      split.connect(st.lr, 0);
      split.connect(st.rl, 1);
      split.connect(st.rr, 1);
      st.ll.connect(st.merge, 0, 0);
      st.rl.connect(st.merge, 0, 0);
      st.lr.connect(st.merge, 0, 1);
      st.rr.connect(st.merge, 0, 1);
      this.widthStage = st;
    }
    this.tailIn.disconnect();
    this.lowCut?.disconnect();
    this.highCut?.disconnect();
    this.widthStage?.merge.disconnect();
    let at: AudioNode = this.tailIn;
    if (lc && this.lowCut) {
      at.connect(this.lowCut);
      at = this.lowCut;
    }
    if (hc && this.highCut) {
      at.connect(this.highCut);
      at = this.highCut;
    }
    if (w && this.widthStage) {
      at.connect(this.widthStage.split);
      at = this.widthStage.merge;
    }
    at.connect(this.wGain);
  }

  private static widthGains(w: number): [number, number, number, number] {
    const a = 0.5 * (1 + w);
    const b = 0.5 * (1 - w);
    return [a, b, b, a];
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'preDelay':
        return [{ param: this.pre.delayTime, map: ident }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      case 'lowCut':
        return this.lowCut ? [{ param: this.lowCut.frequency, map: (v) => Math.max(10, v), exp: true }] : [];
      case 'highCut':
        return this.highCut ? [{ param: this.highCut.frequency, map: (v) => Math.min(this.ctx.sampleRate * 0.45, v), exp: true }] : [];
      case 'width': {
        const st = this.widthStage;
        if (!st) return [];
        return [st.ll, st.lr, st.rl, st.rr].map((n, i) => ({ param: n.gain, map: (v: number) => ReverbUnit.widthGains(v)[i] as number }));
      }
      default:
        return [];
    }
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'reverb') return;
    const p: ReverbParams = slot.params;
    const im = !this.initialized;
    const key = ReverbUnit.irKeyOf(p);
    if (im || !this.realtime) {
      if (key !== this.irKey) this.buildBranch(p, false);
    } else if (key !== this.irKey) {
      // debounce IR regeneration while a knob is being dragged
      this.pendingIr = p;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        const q = this.pendingIr;
        if (q && ReverbUnit.irKeyOf(q) !== this.irKey) this.buildBranch(q, true);
        this.pendingIr = null;
      }, 120);
    }
    // tail stages: only while they do something (or automation drives them)
    const lc = p.lowCut > 20.5 || auto.has('lowCut');
    const hc = p.highCut < 19900 || auto.has('highCut');
    const w = Math.abs(p.width - 1) > 0.005 || auto.has('width');
    this.rewireTail(lc, hc, w);
    if (this.lowCut && !auto.has('lowCut')) setParam(this.lowCut.frequency, p.lowCut, this.ctx, im);
    if (this.highCut && !auto.has('highCut')) setParam(this.highCut.frequency, Math.min(this.ctx.sampleRate * 0.45, p.highCut), this.ctx, im);
    if (this.widthStage && !auto.has('width')) {
      const g = ReverbUnit.widthGains(p.width);
      const st = this.widthStage;
      [st.ll, st.lr, st.rl, st.rr].forEach((n, i) => setParam(n.gain, g[i] as number, this.ctx, im));
    }
    if (!auto.has('preDelay')) setParam(this.pre.delayTime, p.preDelay, this.ctx, im);
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    // depth in ms (the delay line clamps to 0…0.5 s)
    if (key === 'preDelay') return [{ param: this.pre.delayTime, scale: (d) => d / 1000 }];
    return [];
  }

  override dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    super.dispose();
    for (const n of [this.pre, this.dGain, this.tailIn, this.wGain, this.wetDuck, this.lowCut, this.highCut]) n?.disconnect();
    const st = this.widthStage;
    if (st) for (const n of [st.split, st.ll, st.lr, st.rl, st.rr, st.merge]) n.disconnect();
    if (this.branch) {
      this.branch.conv.disconnect();
      this.branch.gain.disconnect();
    }
  }
}

/** Butterworth stage resonances (in dB, as Web Audio's low/high-pass Q expects) for cascaded cuts. */
const BUTTERWORTH_DB: Record<24 | 48, number[]> = {
  24: [0.5412, 1.3066].map((q) => 20 * Math.log10(q)),
  48: [0.5098, 0.6013, 0.9, 2.5629].map((q) => 20 * Math.log10(q)),
};
const STAGES = 4;

/**
 * The biquad stages an enabled band uses (the rest of its row is transparent),
 * as configureBand sets them up. Used to draw the EQ's response.
 */
export function peqStages(band: PeqBand): { type: BiquadFilterType; gain: number; q: number }[] {
  switch (band.type) {
    case 'bell':
      return [{ type: 'peaking', gain: band.gain, q: band.q }];
    case 'lowshelf':
    case 'highshelf':
      return [{ type: band.type, gain: band.gain, q: 1 }];
    case 'notch':
    case 'bandpass':
      return [{ type: band.type, gain: 0, q: band.q }];
    case 'lowcut':
    case 'highcut': {
      const type: BiquadFilterType = band.type === 'lowcut' ? 'highpass' : 'lowpass';
      const qs = band.slope === 12 ? [20 * Math.log10(band.q)] : BUTTERWORTH_DB[band.slope];
      return Array.from({ length: band.slope / 12 }, (_, s) => ({ type, gain: 0, q: qs[s] ?? 0 }));
    }
  }
}

/**
 * Spectra EQ: 8 parametric bands × up to 4 biquad stages each (cuts up to
 * 48 dB/oct are Butterworth cascades). Unused stages are peaking filters with
 * 0 dB gain, which are exactly transparent, so the graph never needs rewiring.
 * The node structure is fixed; band edits only retune filters.
 */
export class PeqUnit extends BaseUnit {
  readonly type = 'peq' as const;
  private readonly stages: BiquadFilterNode[][] = [];
  private readonly out: GainNode;
  readonly analyser: AnalyserNode | null;
  private bands: PeqBand[] = [];
  /** the filters currently in the signal path (only the stages enabled bands use) */
  private chain: BiquadFilterNode[] = [];
  /** short duck while the path is rewired (no click) */
  private readonly swap: GainNode;
  private rewireTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtime: boolean;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    for (let b = 0; b < PEQ_BANDS; b++) {
      const row: BiquadFilterNode[] = [];
      for (let s = 0; s < STAGES; s++) row.push(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, gain: 0, Q: 1 }));
      this.stages.push(row);
    }
    this.swap = new GainNode(ctx);
    this.out = new GainNode(ctx);
    // nothing in the path until the first update: 8 bands × 4 stages of idle filters cost as much
    // as a whole synth, so only the filters that enabled bands use are ever connected
    this.src.connect(this.swap);
    this.swap.connect(this.out);
    this.out.connect(this.wet);
    const realtime = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
    this.realtime = realtime;
    this.analyser = realtime ? new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0.8, minDecibels: -100, maxDecibels: -10 }) : null;
    if (this.analyser) this.out.connect(this.analyser);
  }

  private retype(f: BiquadFilterNode, type: BiquadFilterType): boolean {
    if (f.type === type) return false;
    f.type = type;
    return true;
  }

  // (peqStages mirrors the stage setup here for drawing: keep the two in step)
  private configureBand(i: number, band: PeqBand, im: boolean, auto: ReadonlySet<string>): void {
    const row = this.stages[i] as BiquadFilterNode[];
    const fKey = `b${i}.freq`;
    const gKey = `b${i}.gain`;
    const qKey = `b${i}.q`;
    const transparent = (f: BiquadFilterNode) => {
      const changed = this.retype(f, 'peaking');
      setParam(f.gain, 0, this.ctx, im || changed);
    };
    if (!band.enabled) {
      row.forEach(transparent);
      return;
    }
    const first = row[0] as BiquadFilterNode;
    let used = 1;
    switch (band.type) {
      case 'bell':
      case 'lowshelf':
      case 'highshelf': {
        const changed = this.retype(first, band.type === 'bell' ? 'peaking' : band.type);
        if (!auto.has(gKey)) setParam(first.gain, band.gain, this.ctx, im || changed);
        if (band.type === 'bell' && !auto.has(qKey)) setParam(first.Q, band.q, this.ctx, im || changed);
        break;
      }
      case 'notch':
      case 'bandpass': {
        const changed = this.retype(first, band.type);
        if (!auto.has(qKey)) setParam(first.Q, band.q, this.ctx, im || changed);
        break;
      }
      case 'lowcut':
      case 'highcut': {
        const t: BiquadFilterType = band.type === 'lowcut' ? 'highpass' : 'lowpass';
        used = band.slope / 12;
        const qs = band.slope === 12 ? [20 * Math.log10(band.q)] : BUTTERWORTH_DB[band.slope];
        for (let s = 0; s < used; s++) {
          const f = row[s] as BiquadFilterNode;
          const changed = this.retype(f, t);
          if (!(s === 0 && band.slope === 12 && auto.has(qKey))) setParam(f.Q, qs[s] ?? 0, this.ctx, im || changed);
        }
        break;
      }
    }
    for (let s = 0; s < STAGES; s++) {
      const f = row[s] as BiquadFilterNode;
      if (s >= used) transparent(f);
      if (!auto.has(fKey)) setParam(f.frequency, band.freq, this.ctx, im);
    }
    for (let s = 0; s < used; s++) this.wanted.push(row[s] as BiquadFilterNode);
  }

  private wanted: BiquadFilterNode[] = [];

  /** Put exactly the wanted filters in the path (in band order). Realtime: under a 6 ms duck. */
  private rewire(immediate: boolean): void {
    const want = this.wanted;
    if (want.length === this.chain.length && want.every((f, i) => f === this.chain[i])) return;
    const connect = () => {
      this.src.disconnect();
      for (const f of this.chain) f.disconnect();
      let prev: AudioNode = this.src;
      for (const f of want) {
        prev.connect(f);
        prev = f;
      }
      prev.connect(this.swap);
      this.chain = [...want];
    };
    if (immediate || !this.realtime) {
      if (this.rewireTimer) clearTimeout(this.rewireTimer);
      this.rewireTimer = null;
      connect();
      return;
    }
    const t = this.ctx.currentTime;
    this.swap.gain.cancelScheduledValues(t);
    this.swap.gain.setTargetAtTime(0, t, 0.0015);
    if (this.rewireTimer) clearTimeout(this.rewireTimer);
    this.rewireTimer = setTimeout(() => {
      this.rewireTimer = null;
      connect();
      this.swap.gain.setTargetAtTime(1, this.ctx.currentTime, 0.002);
    }, 12);
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'peq') return;
    const p: PeqParams = slot.params;
    const im = !this.initialized;
    this.bands = p.bands;
    this.wanted = [];
    p.bands.forEach((b, i) => this.configureBand(i, b, im, auto));
    this.rewire(im);
    if (!auto.has('output')) setParam(this.out.gain, dbToGain(p.output), this.ctx, im);
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    if (key === 'output') return [{ param: this.out.gain, map: dbToGain }];
    const bk = parseBandKey(key);
    if (!bk) return [];
    const row = this.stages[bk.band] as BiquadFilterNode[];
    const band = this.bands[bk.band];
    const first = row[0] as BiquadFilterNode;
    if (bk.field === 'freq') return row.map((f) => ({ param: f.frequency, map: ident, exp: true }));
    if (bk.field === 'gain') return [{ param: first.gain, map: ident }];
    const cut12 = band && (band.type === 'lowcut' || band.type === 'highcut');
    return [{ param: first.Q, map: cut12 ? (v) => 20 * Math.log10(Math.max(0.01, v)) : ident }];
  }

  override modulationInputs(key: string): ModInput[] {
    const bk = parseBandKey(key);
    if (!bk) return [];
    const row = this.stages[bk.band] as BiquadFilterNode[];
    if (bk.field === 'freq') return row.map((f) => ({ param: f.detune, scale: (d: number) => d * 100 }));
    if (bk.field === 'gain') return [{ param: (row[0] as BiquadFilterNode).gain, scale: ident }];
    const band = this.bands[bk.band];
    if (bk.field === 'q' && band && (band.type === 'bell' || band.type === 'notch' || band.type === 'bandpass')) return [{ param: (row[0] as BiquadFilterNode).Q, scale: ident }];
    return [];
  }

  /**
   * Magnitude response (linear) of the whole EQ, or of one band, for the given
   * band settings (the device passes them with automation already applied) plus
   * live sidechain offsets. The browser computes it on a scratch filter set up
   * like each stage. It doesn't read the live filters: their values glide to a
   * new setting on the audio clock, which stands still while nothing plays (the
   * curve would lag behind the knobs until playback starts).
   */
  response(bands: readonly PeqBand[], outputDb: number, freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>, band?: number, mods?: ReadonlyMap<number, PeqBandOffset>): void {
    out.fill(1);
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    const sc = (this.scratch ??= new BiquadFilterNode(this.ctx));
    const which = band === undefined ? bands.map((_, i) => i) : [band];
    for (const b of which) {
      const bd = bands[b];
      if (!bd?.enabled) continue;
      const off = mods?.get(b);
      peqStages(bd).forEach((st, s) => {
        sc.type = st.type;
        sc.frequency.value = bd.freq;
        sc.detune.value = off?.cents ?? 0;
        sc.gain.value = st.gain + (s === 0 ? (off?.gain ?? 0) : 0);
        // (cut filters keep their resonance in dB: only bells / notches / band-passes take a Q offset)
        const qOff = s === 0 && (bd.type === 'bell' || bd.type === 'notch' || bd.type === 'bandpass') ? (off?.q ?? 0) : 0;
        sc.Q.value = qOff ? Math.max(0.0001, st.q + qOff) : st.q;
        sc.getFrequencyResponse(freqs, mag, ph);
        for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * (mag[i] as number);
      });
    }
    if (band === undefined) {
      const g = dbToGain(outputDb);
      for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * g;
    }
  }

  private scratch: BiquadFilterNode | null = null;

  override dispose(): void {
    super.dispose();
    if (this.rewireTimer) clearTimeout(this.rewireTimer);
    for (const row of this.stages) for (const f of row) f.disconnect();
    this.swap.disconnect();
    this.out.disconnect();
    this.analyser?.disconnect();
  }
}

/**
 * Chorus / flanger: per channel, a short delay line whose delay time is swept
 * by an LFO (OscillatorNode → depth gain → DelayNode.delayTime, audio-rate),
 * with a feedback path. The right channel's LFO is a PeriodicWave with a phase
 * offset for stereo width. Long delay + no feedback = chorus; very short delay
 * + high (or inverted) feedback = flanger; mix 100 % = vibrato.
 */
class ChorusUnit extends BaseUnit {
  readonly type = 'chorus' as const;
  private readonly up: GainNode;
  private readonly split: ChannelSplitterNode;
  private readonly merge: ChannelMergerNode;
  private readonly delays: DelayNode[] = [];
  private readonly fbs: GainNode[] = [];
  private readonly depths: GainNode[] = [];
  private readonly lfos: OscillatorNode[] = [];
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private width = -1;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    // force stereo so a mono source is chorused on both sides
    this.up = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.up);
    this.up.connect(this.split);
    for (let c = 0; c < 2; c++) {
      const d = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: 0.012 });
      const fb = new GainNode(ctx, { gain: 0 });
      const depth = new GainNode(ctx, { gain: 0 });
      const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.8 });
      this.split.connect(d, c);
      d.connect(fb);
      fb.connect(d);
      d.connect(this.merge, 0, c);
      lfo.connect(depth);
      depth.connect(d.delayTime);
      lfo.start();
      this.delays.push(d);
      this.fbs.push(fb);
      this.depths.push(depth);
      this.lfos.push(lfo);
    }
    this.merge.connect(this.wGain);
    // sidechain stage on the wet signal only ("ducked" reverb / delay / chorus)
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
  }

  private setWidth(w: number): void {
    if (Math.abs(w - this.width) < 1e-4) return;
    this.width = w;
    // sin(ωt + φ) = sin φ·cos ωt + cos φ·sin ωt
    const phi = w * Math.PI;
    const real = new Float32Array([0, Math.sin(phi)]);
    const imag = new Float32Array([0, Math.cos(phi)]);
    (this.lfos[1] as OscillatorNode).setPeriodicWave(new PeriodicWave(this.ctx, { real, imag, disableNormalization: true }));
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'chorus') return;
    const p: ChorusParams = slot.params;
    const im = !this.initialized;
    // the sweep never reaches below zero delay
    const depth = Math.min(p.depth, p.delay * 0.95);
    for (let c = 0; c < 2; c++) {
      if (!auto.has('rate')) setParam((this.lfos[c] as OscillatorNode).frequency, p.rate, this.ctx, im);
      if (!auto.has('depth')) setParam((this.depths[c] as GainNode).gain, depth, this.ctx, im);
      if (!auto.has('delay')) setParam((this.delays[c] as DelayNode).delayTime, p.delay, this.ctx, im);
      if (!auto.has('feedback')) setParam((this.fbs[c] as GainNode).gain, p.feedback, this.ctx, im);
    }
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setWidth(p.width);
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'rate':
        return this.lfos.map((o) => ({ param: o.frequency, map: ident, exp: true }));
      case 'depth':
        return this.depths.map((g) => ({ param: g.gain, map: (v: number) => Math.max(0, v) }));
      case 'delay':
        return this.delays.map((d) => ({ param: d.delayTime, map: (v: number) => Math.min(0.05, Math.max(0.0003, v)) }));
      case 'feedback':
        return this.fbs.map((g) => ({ param: g.gain, map: (v: number) => Math.max(-0.95, Math.min(0.95, v)) }));
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    switch (key) {
      case 'mix':
        return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
      // rate in octaves, through the LFOs' detune (musical, never below 0 Hz)
      case 'rate':
        return this.lfos.map((o) => ({ param: o.detune, scale: (d: number) => d * 1200 }));
      // sweep depth in ms
      case 'depth':
        return this.depths.map((g) => ({ param: g.gain, scale: (d: number) => d / 1000 }));
      default:
        return [];
    }
  }

  override dispose(): void {
    super.dispose();
    for (const o of this.lfos) {
      try {
        o.stop();
      } catch {
        // already stopped
      }
      o.disconnect();
    }
    for (const n of [...this.delays, ...this.fbs, ...this.depths, this.up, this.split, this.merge, this.dGain, this.wGain, this.wetDuck]) n.disconnect();
  }
}

/**
 * Auto-Filter: two cascaded biquads (24 dB/oct; the resonance sits on the
 * second) whose cutoff an LFO sweeps through their detune (in octaves, so the
 * sweep is musical). Synced LFOs follow the tempo. Dry/wet like the others,
 * with a sidechain-able cutoff (octaves) and wet level.
 */
export class AutoFilterUnit extends BaseUnit {
  readonly type = 'autofilter' as const;
  private readonly f1: BiquadFilterNode;
  private readonly f2: BiquadFilterNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private mode: AutoFilterMode | null = null;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.f1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 0 });
    this.f2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 0 });
    this.lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.5 });
    this.lfoGain = new GainNode(ctx, { gain: 0 });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.f1);
    this.f1.connect(this.f2);
    this.f2.connect(this.wGain);
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.f1.detune);
    this.lfoGain.connect(this.f2.detune);
    this.lfo.start();
  }

  /** resonance 0..1 → the biquads' Q (dB for low/high-pass, linear for band-pass) */
  private q(reso: number, mode: AutoFilterMode): { q1: number; q2: number } {
    if (mode === 'bandpass') return { q1: 0.7 + reso * 2, q2: 0.7 + reso * 9 };
    // 24 dB/oct Butterworth stages (0.54, 1.31) with the peak added on the second
    return { q1: 20 * Math.log10(0.5412), q2: 20 * Math.log10(1.3066) + reso * 16 };
  }

  update(slot: EffectSlot, bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'autofilter') return;
    const p: AutoFilterParams = slot.params;
    const im = !this.initialized;
    const typeChanged = this.mode !== p.mode;
    if (typeChanged) {
      this.f1.type = p.mode;
      this.f2.type = p.mode;
      this.mode = p.mode;
    }
    if (!auto.has('cutoff')) {
      setParam(this.f1.frequency, p.cutoff, this.ctx, im);
      setParam(this.f2.frequency, p.cutoff, this.ctx, im);
    }
    if (!auto.has('reso') || typeChanged) {
      const { q1, q2 } = this.q(p.reso, p.mode);
      setParam(this.f1.Q, q1, this.ctx, im || typeChanged);
      setParam(this.f2.Q, q2, this.ctx, im || typeChanged);
    }
    if (this.lfo.type !== p.shape) this.lfo.type = p.shape;
    setParam(this.lfo.frequency, autoFilterLfoHz(p, bpm), this.ctx, im);
    if (!auto.has('lfoDepth')) setParam(this.lfoGain.gain, p.lfoDepth * 1200, this.ctx, im);
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'cutoff':
        return [this.f1, this.f2].map((f) => ({ param: f.frequency, map: (v: number) => Math.min(20000, Math.max(20, v)), exp: true }));
      case 'reso':
        return [{ param: this.f2.Q, map: (v: number) => this.q(v, this.mode ?? 'lowpass').q2 }];
      case 'lfoDepth':
        return [{ param: this.lfoGain.gain, map: (v: number) => Math.max(0, v) * 1200 }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    // cutoff in octaves (through detune: the sidechain opens / closes the filter musically)
    if (key === 'cutoff') return [this.f1, this.f2].map((f) => ({ param: f.detune, scale: (d: number) => d * 1200 }));
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    return [];
  }

  /** magnitude response of the filter at its current settings (for the device's curve) */
  response(freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>, cents = 0): void {
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    out.fill(1);
    for (const f of [this.f1, this.f2]) {
      const d = f.detune.value;
      f.detune.value = d + cents;
      f.getFrequencyResponse(freqs, mag, ph);
      f.detune.value = d;
      for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * (mag[i] as number);
    }
  }

  override dispose(): void {
    super.dispose();
    try {
      this.lfo.stop();
    } catch {
      // already stopped
    }
    for (const n of [this.f1, this.f2, this.lfo, this.lfoGain, this.dGain, this.wGain, this.wetDuck]) n.disconnect();
  }
}

/**
 * Phaser: the phasr-phaser worklet (swept all-passes with feedback, wet only)
 * mixed with the dry signal. Its centre, depth, feedback and stereo offset are
 * worklet AudioParams; the sidechain shifts the centre in octaves.
 */
export class PhaserUnit extends BaseUnit {
  readonly type = 'phaser' as const;
  private readonly node: AudioWorkletNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private stages = -1;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.node = new AudioWorkletNode(ctx, 'phasr-phaser', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.node);
    this.node.connect(this.wGain);
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
  }

  private param(name: string): AudioParam {
    return this.node.parameters.get(name) as AudioParam;
  }

  update(slot: EffectSlot, bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'phaser') return;
    const p: PhaserParams = slot.params;
    const im = !this.initialized;
    if (p.stages !== this.stages) {
      this.stages = p.stages;
      this.node.port.postMessage({ type: 'stages', stages: p.stages });
    }
    if (!auto.has('center')) setParam(this.param('center'), p.center, this.ctx, im);
    if (!auto.has('depth')) setParam(this.param('depth'), p.depth, this.ctx, im);
    if (!auto.has('feedback')) setParam(this.param('feedback'), p.feedback, this.ctx, im);
    setParam(this.param('stereo'), p.stereo, this.ctx, im);
    setParam(this.param('rate'), phaserLfoHz(p, bpm), this.ctx, im);
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'center':
        return [{ param: this.param('center'), map: (v: number) => Math.min(18000, Math.max(20, v)), exp: true }];
      case 'depth':
        return [{ param: this.param('depth'), map: (v: number) => Math.max(0, v) }];
      case 'feedback':
        return [{ param: this.param('feedback'), map: (v: number) => Math.max(-0.95, Math.min(0.95, v)) }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'center') return [{ param: this.param('shift'), scale: ident }];
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    return [];
  }

  override dispose(): void {
    super.dispose();
    this.node.port.postMessage({ type: 'dispose' });
    for (const n of [this.node, this.dGain, this.wGain, this.wetDuck]) n.disconnect();
  }
}

/**
 * Reverb Lite: the phasr-room worklet (diffusers + feedback delay network,
 * wet only) after a pre-delay, mixed with the dry signal. Decay, size and
 * tone are worklet AudioParams (automatable; decay also takes a sidechain in
 * seconds), and the worklet sleeps while its input and tail are silent.
 */
export class RoomUnit extends BaseUnit {
  readonly type = 'room' as const;
  private readonly node: AudioWorkletNode;
  private readonly pre: DelayNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.node = new AudioWorkletNode(ctx, 'phasr-room', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.5 });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.pre);
    this.pre.connect(this.node);
    this.node.connect(this.wGain);
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
  }

  private param(name: string): AudioParam {
    return this.node.parameters.get(name) as AudioParam;
  }

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'room') return;
    const p: RoomParams = slot.params;
    const im = !this.initialized;
    if (!auto.has('decay')) setParam(this.param('decay'), p.decay, this.ctx, im);
    // size moves delay lengths: the worklet glides it, so it's set directly
    this.param('size').value = p.size;
    if (!auto.has('tone')) setParam(this.param('tone'), p.tone, this.ctx, im);
    if (!auto.has('preDelay')) setParam(this.pre.delayTime, p.preDelay, this.ctx, im);
    if (!auto.has('mix')) {
      const g = mixGains(p.mix);
      setParam(this.dGain.gain, g.dry, this.ctx, im);
      setParam(this.wGain.gain, g.wet, this.ctx, im);
    }
    this.setEnabled(slot.enabled);
    this.initialized = true;
  }

  automationParams(key: string): ParamTarget[] {
    switch (key) {
      case 'decay':
        return [{ param: this.param('decay'), map: (v: number) => Math.max(0.1, v), exp: true }];
      case 'tone':
        return [{ param: this.param('tone'), map: (v: number) => Math.min(20000, Math.max(200, v)), exp: true }];
      case 'preDelay':
        return [{ param: this.pre.delayTime, map: ident }];
      case 'mix':
        return [
          { param: this.dGain.gain, map: (v) => mixGains(v).dry },
          { param: this.wGain.gain, map: (v) => mixGains(v).wet },
        ];
      default:
        return [];
    }
  }

  override modulationInputs(key: string): ModInput[] {
    if (key === 'mix') return [{ param: this.wetDuck.gain, scale: wetDuckScale }];
    // depth in seconds of decay (a kick can choke the tail: negative depth)
    if (key === 'decay') return [{ param: this.param('decayShift'), scale: ident }];
    if (key === 'preDelay') return [{ param: this.pre.delayTime, scale: (d) => d / 1000 }];
    return [];
  }

  override dispose(): void {
    super.dispose();
    this.node.port.postMessage({ type: 'dispose' });
    for (const n of [this.node, this.pre, this.dGain, this.wGain, this.wetDuck]) n.disconnect();
  }
}

export function createEffectUnit(ctx: BaseAudioContext, slot: EffectSlot, bpm: number, automated?: ReadonlySet<string>): EffectUnit {
  let unit: BaseUnit;
  switch (slot.type) {
    case 'eq':
      unit = new EqUnit(ctx, slot.id);
      break;
    case 'peq':
      unit = new PeqUnit(ctx, slot.id);
      break;
    case 'chorus':
      unit = new ChorusUnit(ctx, slot.id);
      break;
    case 'autofilter':
      unit = new AutoFilterUnit(ctx, slot.id);
      break;
    case 'phaser':
      unit = new PhaserUnit(ctx, slot.id);
      break;
    case 'compressor':
      unit = new CompressorUnit(ctx, slot.id);
      break;
    case 'limiter':
      unit = new LimiterUnit(ctx, slot.id);
      break;
    case 'delay':
      unit = new DelayUnit(ctx, slot.id);
      break;
    case 'reverb':
      unit = new ReverbUnit(ctx, slot.id);
      break;
    case 'room':
      unit = new RoomUnit(ctx, slot.id);
      break;
    case 'saturator':
      unit = new SaturatorUnit(ctx, slot.id);
      break;
    case 'utility':
      unit = new UtilityUnit(ctx, slot.id);
      break;
  }
  unit.update(slot, bpm, automated);
  return unit;
}

/** A unit with a gain-reduction meter (compressor, limiter). */
export function isCompressorUnit(u: EffectUnit): u is EffectUnit & { reduction(): number } {
  return u.type === 'compressor' || u.type === 'limiter';
}
