/**
 * Insert effect units built from native Web Audio nodes, so they run in both
 * the realtime AudioContext and an OfflineAudioContext (WAV export).
 *
 * Every unit is wrapped in a click-free bypass: input feeds both a dry path
 * and the processing path, and enabling/disabling crossfades the two.
 * All parameter changes use setTargetAtTime smoothing to avoid zipper noise.
 */
import { dbToGain } from '../../core/ids';
import type { AutoFilterMode, AutoFilterParams, PhaserParams, ChorusParams, CompressorParams, DelayParams, EffectSlot, EffectType, EqParams, PeqBand, PeqParams, ReverbParams } from '../../project/types';
import { parseBandKey } from '../../project/automation';
import { generateImpulse } from './impulse';
import { MAX_DELAY_SECONDS, PEQ_BANDS, autoFilterLfoHz, delayTimeSeconds, mixGains, phaserLfoHz } from './specs';

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
      const cut = () => {
        if (this.enabled || !this.srcConnected) return;
        this.input.disconnect(this.src);
        this.srcConnected = false;
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
 * Convolution reverb with a generated IR. Changing the decay generates a new
 * IR on a fresh ConvolverNode and crossfades to it, so there is no click and
 * the old tail finishes naturally.
 */
class ReverbUnit extends BaseUnit {
  readonly type = 'reverb' as const;
  private readonly pre: DelayNode;
  private readonly dGain: GainNode;
  private readonly wGain: GainNode;
  private readonly wetDuck: GainNode;
  private branch: { conv: ConvolverNode; gain: GainNode } | null = null;
  private decay = -1;
  private pendingDecay: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly realtime: boolean;

  constructor(ctx: BaseAudioContext, id: string) {
    super(ctx, id);
    this.realtime = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.5 });
    this.dGain = new GainNode(ctx);
    this.wGain = new GainNode(ctx);
    this.wetDuck = new GainNode(ctx, { gain: 1 });
    this.src.connect(this.dGain);
    this.dGain.connect(this.wet);
    this.src.connect(this.pre);
    // sidechain stage on the wet signal only ("ducked" reverb / delay / chorus)
    this.wGain.connect(this.wetDuck);
    this.wetDuck.connect(this.wet);
  }

  private buildBranch(decay: number, fadeIn: boolean): void {
    const [l, r] = generateImpulse(this.ctx.sampleRate, decay);
    const buf = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate: this.ctx.sampleRate });
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    const conv = new ConvolverNode(this.ctx, { buffer: buf, disableNormalization: false });
    const gain = new GainNode(this.ctx, { gain: fadeIn ? 0 : 1 });
    this.pre.connect(conv);
    conv.connect(gain);
    gain.connect(this.wGain);
    const old = this.branch;
    this.branch = { conv, gain };
    this.decay = decay;
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

  automationParams(key: string): ParamTarget[] {
    switch (key) {
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

  update(slot: EffectSlot, _bpm: number, auto: ReadonlySet<string> = NONE): void {
    if (slot.type !== 'reverb') return;
    const p: ReverbParams = slot.params;
    const im = !this.initialized;
    if (im || !this.realtime) {
      if (Math.abs(p.decay - this.decay) > 1e-6) this.buildBranch(p.decay, false);
    } else if (Math.abs(p.decay - this.decay) > 1e-3) {
      // debounce IR regeneration while a knob is being dragged
      this.pendingDecay = p.decay;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        if (this.pendingDecay !== null && Math.abs(this.pendingDecay - this.decay) > 1e-3) this.buildBranch(this.pendingDecay, true);
        this.pendingDecay = null;
      }, 120);
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
    this.pre.disconnect();
    this.dGain.disconnect();
    this.wGain.disconnect();
    this.wetDuck.disconnect();
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
   * Magnitude response (linear) of the whole EQ, or of one band, computed by
   * the browser from the live filter nodes — the drawn curve is the real one.
   */
  response(freqs: Float32Array<ArrayBuffer>, out: Float32Array<ArrayBuffer>, band?: number, mods?: ReadonlyMap<number, PeqBandOffset>): void {
    out.fill(1);
    const mag = new Float32Array(freqs.length);
    const ph = new Float32Array(freqs.length);
    const bands = band === undefined ? this.stages.map((_, i) => i) : [band];
    for (const b of bands) {
      const row = this.stages[b] as BiquadFilterNode[];
      const off = mods?.get(b);
      row.forEach((f, s) => {
        // sidechain offsets (they reach the filters through AudioParam inputs, which the
        // nodes' own response doesn't include): mirror the stage on a scratch filter
        const src = off ? this.offsetStage(f, s, off) : f;
        src.getFrequencyResponse(freqs, mag, ph);
        for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * (mag[i] as number);
      });
    }
    if (band === undefined) {
      const g = this.out.gain.value;
      for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * g;
    }
  }

  private scratch: BiquadFilterNode[] = [];
  private offsetStage(f: BiquadFilterNode, stage: number, off: PeqBandOffset): BiquadFilterNode {
    const sc = (this.scratch[stage] ??= new BiquadFilterNode(this.ctx));
    sc.type = f.type;
    sc.frequency.value = f.frequency.value;
    sc.detune.value = f.detune.value + (off.cents ?? 0);
    sc.gain.value = f.gain.value + (stage === 0 ? (off.gain ?? 0) : 0);
    // (cut filters keep their resonance in dB: only bells / notches / band-passes take a Q offset)
    sc.Q.value = stage === 0 && off.q ? Math.max(0.0001, f.Q.value + off.q) : f.Q.value;
    return sc;
  }

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
    case 'delay':
      unit = new DelayUnit(ctx, slot.id);
      break;
    case 'reverb':
      unit = new ReverbUnit(ctx, slot.id);
      break;
  }
  unit.update(slot, bpm, automated);
  return unit;
}

export function isCompressorUnit(u: EffectUnit): u is EffectUnit & { reduction(): number } {
  return u.type === 'compressor';
}
