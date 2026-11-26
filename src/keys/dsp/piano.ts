/**
 * Keyforge piano engine — modal string model.
 *
 * Each note is a bank of exponentially decaying complex resonators, one per
 * string partial, driven by a smooth hammer force pulse:
 *
 *  - Stiff-string inharmonicity: f_k = k·f1·√((1+B·k²)/(1+B)), with B rising
 *    towards the treble (and slightly in the low bass), plus a Railsback-style
 *    stretch of the tuning.
 *  - Hammer: the excitation spectrum depends on velocity (harder hammer felt
 *    → brighter), strike position (comb notch near k ≈ 1/x0) and pitch.
 *  - Strings: the lower partials get two or three resonators (coupled
 *    unison strings / polarisations) slightly detuned with different decay
 *    rates. Their sum gives real beating and the characteristic piano
 *    "double decay": a fast prompt sound followed by a long aftersound that
 *    keeps a gentle beat.
 *  - Losses: per-partial decay grows with frequency² (high partials die
 *    first), the fundamental's T60 follows a measured-style curve from ~20 s
 *    in the bass to <1 s at the top.
 *  - Dampers: key release adds strong damping (less effective in the bass),
 *    the top ~20 keys have no dampers, and the felt touching the string
 *    makes a soft noise. The sustain pedal lifts all dampers.
 *  - Soundboard: a small bank of fixed body modes (driven by the hammer
 *    knock and the strings) and 12 undamped "sympathetic strings" (combs
 *    tuned to C2…B2) that bloom when the pedal is down.
 *  - Tension modulation: a hard strike stretches the string, so the pitch
 *    starts a few cents sharp and settles within ~0.1 s (more in the bass).
 *  - No two strikes are identical: small per-strike variation of level and
 *    hammer tone, and a recording-room ambience (8-line FDN, "Room").
 *
 * A restrike of a sounding note hits the same string again (state is kept
 * and the new excitation adds to it), as on a real piano.
 */
import {
  BEND_SEMITONES,
  DelayLine,
  FdnReverb,
  HeldIds,
  LN_1000,
  MAX_BLOCK,
  Smoother,
  TWO_PI,
  ToneFilter,
  clamp,
  hash01,
  interpTable,
  midiToHz,
  panGains,
  type KeysEngine,
} from './common';
import { allocateVoice } from '../../synth/dsp/voiceAllocator';
import { Noise } from '../../synth/dsp/oscillator';

export const PIANO_MAX_PARTIALS = 96;
/** partials 1..DOUBLE_PARTIALS get a prompt and an aftersound resonator */
const DOUBLE_PARTIALS = 24;
/** partials 1..TRIPLE_PARTIALS also get a second, detuned aftersound resonator */
const TRIPLE_PARTIALS = 12;
/** partials 2..PHANTOM_MAX get a "phantom" partial at exactly 2·f_k (bass and middle) */
const PHANTOM_MAX = 10;
/** partials 2..HIT_MAX get a short "hit" component (the bright flash of the hammer strike) */
const HIT_MAX = 40;
const MAX_RES = PIANO_MAX_PARTIALS + DOUBLE_PARTIALS + TRIPLE_PARTIALS + PHANTOM_MAX + HIT_MAX + 2;
/** share of the second aftersound string (beating in the tail) */
const AFTER2_SHARE = 0.18;
const POLYPHONY = 32;
/** keys at or above this note have no dampers */
export const PIANO_NO_DAMPER_NOTE = 89;
/** share of the initial amplitude in the fast "prompt" component (mid/bass; less in the treble) */
const PROMPT_SHARE = 0.75;
/** prompt component decays this many times faster than the aftersound */
const PROMPT_RATE = 6.5;
/** a resonator is dropped below this energy (≈ −94 dBFS amplitude) */
const DEAD_ENERGY = 4e-10;
const LEVEL = 0.178;
/** soundboard (wood) resonator level at Body = 100 % */
const WOOD_GAIN = 2.2;

/** fundamental T60 (seconds) by MIDI note, before the Sustain multiplier */
/** heavy-hammer thud: body/case resonances [Hz, T60 s, weight, pan] */
const THUD_MODES = [
  [72, 0.16, 1, 0],
  [118, 0.12, 0.8, -0.35],
  [176, 0.09, 0.6, 0.35],
  [240, 0.06, 0.4, -0.15],
] as const;

const FUND_T60: readonly (readonly [number, number])[] = [
  // (recorded A♯0: the whole note fades ≈ 6–7 dB/s, i.e. ~9–10 s)
  [21, 10],
  [36, 13],
  // middle fitted to recorded held notes (C♯4–G4 fundamentals fade ~9–24 dB/s): ~3–6 s
  [48, 12],
  [60, 9],
  [72, 6.5],
  [84, 4.5],
  [96, 4.5],
  [108, 2.6],
];

export interface PianoParams {
  brightness: number;
  hardness: number;
  hammerNoise: number;
  strike: number;
  sustain: number;
  damping: number;
  unison: number;
  inharm: number;
  stretch: number;
  /** weight of the hammer impact: low thud through soundboard and case */
  impact: number;
  /** strength of the soundboard radiation response (0 = bare strings) */
  board: number;
  /** onset bloom time scale (0 = instant) */
  bloom: number;
  /** brightness flash of the hammer strike */
  hit: number;
  /** phantom-partial (longitudinal) level: the metallic zing of steel strings */
  metal: number;
  damper: number;
  releaseNoise: number;
  resonance: number;
  body: number;
  tone: number;
  room: number;
  width: number;
  velCurve: number;
  master: number;
}

// ---------------------------------------------------------------------------
// Pure model functions (exported for tests)
// ---------------------------------------------------------------------------

/** inharmonicity coefficient B for a note (inharm = 1 → typical grand) */
export function inharmonicityB(note: number, inharm: number): number {
  // (low bass: a recorded A0 measures B ≈ 3·10⁻⁴ — thick wound strings are stiff)
  const log = note >= 35 ? -4 + 0.0235 * (note - 35) : -4 + 0.033 * (35 - note);
  return Math.pow(10, log) * inharm;
}

/** tuning stretch in cents (Railsback-like: flat bass, sharp treble) */
export function stretchCents(note: number, stretch: number): number {
  const d = clamp((note - 64) / 44, -1.2, 1.2);
  return stretch * 30 * d * d * d;
}

/** tuned fundamental (Hz) of a note */
export function pianoFundamental(note: number, stretch: number): number {
  return midiToHz(note) * Math.pow(2, stretchCents(note, stretch) / 1200);
}

/** frequency of partial k of a stiff string with fundamental f1 */
export function partialFrequency(f1: number, k: number, B: number): number {
  return k * f1 * Math.sqrt((1 + B * k * k) / (1 + B));
}

/** aftersound T60 of the fundamental (seconds) */
export function fundamentalT60(note: number, sustain: number): number {
  return interpTable(FUND_T60, note) * sustain;
}

/** frequency-dependent loss coefficient (1/s per Hz²) */
function lossB3(damping: number): number {
  // ≈ 1.6e-7 s⁻¹/Hz² at the default: a 4 kHz partial of middle C rings ~2 s, 8 kHz ~0.7 s
  return 1.6e-7 * (0.25 + 1.5 * damping);
}

/**
 * The f² loss law fits the bass and middle; short, stiff treble strings keep
 * their few overtones much longer relative to the fundamental, so the
 * frequency-dependent loss is scaled down above ~E4.
 */
function trebleLossScale(f1: number): number {
  // above ~E4: less loss (short stiff strings keep their few overtones);
  // in the bass: more (wound strings lose their upper partials within a second or two)
  return f1 >= 330 ? Math.pow(330 / f1, 1.1) : Math.min(3, Math.pow(330 / f1, 0.65));
}

/** treble position 0 (≤ C4) … 1 (≥ C7) */
function trebleness(note: number): number {
  return clamp((note - 60) / 36, 0, 1);
}

/** coupled-string double decay is weaker in the treble: smaller, slower prompt component */
export function promptShare(note: number): number {
  const low = clamp((70 - note) / 4, 0, 1);
  return low * (PROMPT_SHARE - 0.4 * trebleness(note)) + (1 - low) * (0.6 - 0.25 * trebleness(note));
}

/**
 * How strongly partial k takes part in the fast prompt decay. The
 * fundamental couples best to the soundboard and loses energy fastest in the
 * first second; the 2nd–6th partials hold on (in recordings of held notes
 * they even grow relative to the fundamental), so the tone keeps singing
 * instead of going dull like a pluck.
 */
/**
 * Swell of the 3rd–8th partials (energy passing from the hammer-driven
 * vibration into the strings' other polarisation): their "prompt" part has
 * negative sign, so the partial starts lower and fills in over ~0.2 s — as
 * measured on held grand-piano notes, where these partials grow 6–13 dB
 * relative to the fundamental within the first half second. Bass and middle;
 * gone in the top octaves.
 */
const SWELL_SIGMA = 6;
export function swellAmount(note: number): number {
  return 0.45 * clamp((86 - note) / 14, 0, 1);
}

export function promptWeight(k: number): number {
  // the fundamental takes the fast decay; the 2nd partial only a little (recorded C♯4/E4: it barely decays)
  return k <= 1 ? 1.4 : k === 2 ? 0.9 : 0.3;
}

export function promptRate(note: number): number {
  // strong prompt decay up to ~F♯4 (fitted to recorded C♯4/E4); from ~A♯4 up the gentler
  // values that matched the recorded G4/C5
  const low = clamp((70 - note) / 4, 0, 1);
  return low * (PROMPT_RATE - 5.0 * trebleness(note)) + (1 - low) * (2.6 - 1.1 * trebleness(note));
}

/** T60 of a partial at frequency f for a note whose fundamental is f1 */
export function partialT60(note: number, f: number, f1: number, p: Pick<PianoParams, 'sustain' | 'damping'>): number {
  const s1 = LN_1000 / fundamentalT60(note, p.sustain);
  // soundboard coupling loss is largest for the fundamental and smaller for the upper partials
  // (recorded held notes: the fundamental fades fastest, the overtones linger — "damped but clean")
  // (bass: partials up to ~250 Hz still sit where the soundboard takes energy readily)
  // (only below the top octaves — the treble was right without it)
  const reduce = clamp((84 - note) / 12, 0, 1);
  const coupling = 1 - reduce * (1 - clamp(1 / (1 + 0.3 * Math.max(0, f / Math.max(f1, 250) - 1)), 0.45, 1));
  const s = s1 * coupling + lossB3(p.damping) * trebleLossScale(f1) * Math.max(0, f * f - f1 * f1);
  return LN_1000 / s;
}

/** relative strike amplitude of partial k (before energy normalisation) */
/** brightness index of a strike (0…1.4) */
export function strikeBrightness(vel: number, p: Pick<PianoParams, 'brightness' | 'hardness'>): number {
  const velTone = 1 - p.hardness + p.hardness * Math.pow(vel, 1.5);
  // (medium touch ≈ unchanged; soft is rounder and hard brighter than before)
  return clamp(p.brightness * (0.1 + 1.15 * velTone), 0, 1.4);
}

/** treble position used by the hammer model: sets in from about A3, complete around C6 */
export function hammerTreble(note: number): number {
  return Math.pow(clamp((note - 57) / 30, 0, 1), 0.8);
}

/**
 * Corner frequency and slope of the hammer's (sustained-tone) spectrum.
 * Felt stiffens as it's compressed, so the corner rises with velocity; on
 * short treble strings the hammer stays in contact for about one period,
 * which caps the corner at a few harmonics (treble notes are dominated by
 * their fundamental).
 */
export function hammerCorner(f1: number, b: number, treb: number): { fc: number; slope: number; open: number } {
  const absCorner = (300 + 7600 * b * b) * Math.pow(f1 / 262, f1 < 262 ? 0.35 : 0.3);
  const harmonicCap = f1 * (0.9 + 2.2 * b + 20 * (1 - treb) * (1 - treb));
  // `open`: the uncapped corner — the instant of impact itself is not limited by the contact time
  // soft (uncompressed) felt also rolls off more steeply: pp sounds rounder, not just quieter
  const soft = clamp(0.65 - b, 0, 0.5);
  return { fc: Math.min(f1 + absCorner, harmonicCap), slope: 1.6 + 0.6 * treb + 2.2 * soft, open: f1 + absCorner };
}

export function hammerSpectrum(note: number, k: number, f: number, f1: number, vel: number, p: Pick<PianoParams, 'brightness' | 'hardness' | 'strike'> & { board?: number }): number {
  const b = strikeBrightness(vel, p);
  const treb = hammerTreble(note);
  const bassness = clamp((52 - note) / 31, 0, 1);
  // felt hammers stiffen as they're compressed, so the spectrum falls off
  // (≈ −10 dB/oct) above a velocity-dependent corner …
  const { fc, slope } = hammerCorner(f1, b, treb);
  const hammer = 1 / (1 + Math.pow(f / fc, slope));
  // strike point: 1/8 in the mid range, closer to the agraffe in the treble
  const x0 = p.strike * (1 - 0.3 * clamp((note - 60) / 48, 0, 1));
  // the hammer's finite width keeps the notch shallow; on short treble strings
  // the hammer is wide relative to the string and the comb all but disappears
  // (deeper in the bass: the recorded A0 shows −30 dB notches at the strike-point partials)
  const floor = 0.35 - 0.25 * clamp((48 - note) / 27, 0, 1);
  // a wide felt hammer hardly cuts the fundamental at its strike point (the recorded middle notes
  // have their strongest component at the fundamental)
  const comb0 = k === 1 ? 0.9 : floor + (1 - floor) * Math.abs(Math.sin(Math.PI * k * x0));
  const comb = comb0 + (1 - comb0) * 0.6 * treb;
  // real partial levels are irregular (hammer–string interaction, soundboard
  // radiation): ±3 dB fixed per note and partial. Perfectly smooth spectra sound synthetic.
  const irregular = 1 + 0.7 * (hash01(note * 131 + 7, k) - 0.5);
  // spectral slope: steeper in the bass (no buzzy, saw-like overtone series) and in the treble
  // (bass: nearly flat in k — the soundboard response shapes the low range, as in the recorded A0)
  const tilt = Math.pow(k, -(0.35 - 0.25 * bassness + 0.6 * treb));
  // soundboard radiates the lowest fundamentals poorly
  // soundboard radiates poorly below its lowest modes (fitted to a recorded A♯0: the fundamental is ~30 dB under the partials around 300 Hz)
  // (fitted to a recorded A0: partials below ~150 Hz sit 8–30 dB under the 300–650 Hz region)
  const board = 1 / (1 + Math.pow(230 / f, 2.5));
  const air = 1 / (1 + (f / 14000) * (f / 14000));
  return hammer * comb * tilt * board * air * irregular * radiation(f, note, p.board ?? 1);
}

/**
 * Soundboard radiation response, fitted to recordings of held grand-piano
 * notes (A♯0, C♯4–C5): partials radiate fully up to ~600 Hz, then the
 * response drops steeply (~−10 dB by 850 Hz) and keeps falling ≈ −10 dB/oct.
 * Without it the bass and middle sound like bare, bright strings (harp-like).
 * Faded out over the top octaves, whose sound is right without it.
 */
export function radiation(f: number, note: number, strength = 1): number {
  const w = clamp((84 - note) / 12, 0, 1);
  if (w <= 0 || f <= 560) return 1;
  const dbDrop = f < 850 ? 10 * (Math.log2(f / 560) / Math.log2(850 / 560)) : 10 + 6.5 * Math.log2(f / 850);
  return Math.pow(10, (-dbDrop * w * strength) / 20);
}

/** detune (cents) between the two strings of partial k */
function stringDetune(note: number, k: number, unison: number): number {
  // treble trichords are never perfectly unison: their slow shimmer is what
  // separates a piano's top octaves from a single, pure tine (music box)
  return unison * (1 + 1.6 * trebleness(note)) * (0.55 + 0.9 * hash01(note, k));
}

/** level of the third string in the treble */
function after2Share(note: number, k = 1): number {
  const top = AFTER2_SHARE + 0.06 * trebleness(note);
  // below the top octaves: a strong third string on the overtones (deep, independent beats), gentle on the fundamental
  const live = clamp((84 - note) / 12, 0, 1);
  return top + live * ((k === 1 ? 0.12 : 0.4) - top);
}

/**
 * Beat rate (Hz) of partial k against the third string. Recorded held notes
 * show every overtone swelling and dipping by 10–20 dB at its own pace
 * (0.5–3 Hz) while the fundamental fades smoothly — the life of a piano tone.
 * Independent rates keep the overall level steady (no common dip).
 */
export function beatRate(note: number, k: number, unison: number): number {
  const h = hash01(note * 7 + 3, k * 13 + 1);
  return (unison / 0.8) * (k === 1 ? 0.15 + 0.25 * h : 0.45 + 2.1 * h);
}

// ---------------------------------------------------------------------------

class PianoVoice {
  active = false;
  note = 60;
  order = 0;
  vel = 0;
  readonly held = new HeldIds();
  /** keys are up while the pedal is down */
  sustained = false;
  damped = false;
  /** whether the keys are up (counts as releasing for voice stealing) */
  released = false;
  /** number of live resonators */
  n = 0;
  readonly pid = new Int32Array(MAX_RES);
  readonly re = new Float64Array(MAX_RES);
  readonly im = new Float64Array(MAX_RES);
  readonly a = new Float64Array(MAX_RES);
  readonly b = new Float64Array(MAX_RES);
  readonly gin = new Float64Array(MAX_RES);
  /**
   * Quadrature part of the excitation. A hammer launches a wave along a stiff
   * string: high partials travel faster (dispersion), so they reach the
   * bridge spread over a few milliseconds instead of all starting in phase.
   * All-in-phase partials form a click at the onset — the sound of a string
   * released from a bent shape (a plucked guitar). Spread most in the bass.
   */
  readonly ginQ = new Float64Array(MAX_RES);
  /** which of the two radiation points (stereo positions) the resonator feeds */
  readonly side = new Uint8Array(MAX_RES);
  // hammer force pulse: g(j) = j·e^{-j/τ} / norm
  pulsePos = 0;
  pulseLen = 0;
  pulseTau = 1;
  pulseNorm = 1;
  // stealing
  killing = false;
  fade = 1;
  fadeStep = 0;
  pendingNote = -1;
  pendingVel = 0;
  pendingId = 0;
  gAL = 0.7;
  gAR = 0.7;
  gBL = 0.7;
  gBR = 0.7;
  /** tension-modulation pitch offset (cents), decays after the strike */
  glide = 0;
  /**
   * Onset bloom: measured grand-piano recordings take ~4–12 ms to come within
   * 6 dB of full level and peak at ~16–34 ms (soundboard response building up
   * under the strings), instead of peaking in the first millisecond like a
   * plucked string. Samples since the strike, and the bloom time constant.
   */
  onsetPos = 1e9;
  onsetTau = 1;

  get resonating(): boolean {
    return this.active && !this.killing;
  }
}

/** resonator id: partial k (1-based), string s (0 = prompt, 1 = aftersound / single) */
/** resonator id: partial k (1-based), string s (0 = prompt, 1 = aftersound / single, 2 = second aftersound) */
const pidOf = (k: number, s: number) => k * 8 + s;
const S_PROMPT = 0;
const S_AFTER = 1;
const S_AFTER2 = 2;
/**
 * Phantom partial: the string's stretching couples transverse motion into
 * longitudinal vibration, producing components at sums of partial
 * frequencies — here 2·f_k, which sits slightly below the (stretched)
 * partial 2k. Their beating against the real partials is the metallic
 * "zing" of steel piano strings.
 */
const S_PHANTOM = 3;
/**
 * Hit: while the hammer is on the string it drives the upper partials far
 * harder than the free string can sustain; that energy is gone within tens
 * of milliseconds. This brief, bright flash is the clean "hit" of a hammer
 * — a pluck instead loses its brightness gradually.
 */
const S_HIT = 4;

/** how long the hit flash lasts at frequency f (T60, seconds) */
/**
 * Longitudinal modes: steel strings also vibrate lengthwise. Their
 * frequencies don't follow the note (they depend on string length and
 * material — roughly 1–3 kHz in the bass and low middle), they're driven
 * through the string's stretching (so they grow with the square of the
 * strike) and ring briefly. They give wound bass and low-mid strings the
 * metallic "clang" at the onset that gut or nylon strings (a harp) lack.
 */
const S_LONG = 5;

/** first longitudinal mode frequency for a note (Hz) */
export function longitudinalFreq(note: number): number {
  // f = c / 2L for steel (c ≈ 5 km/s): ≈ 1.25 kHz for a ~2 m A0 string, rising as strings get shorter
  return clamp(1250 * Math.pow(2, (note - 21) / 26) * (1 + 0.08 * (hash01(note, 77) - 0.5)), 900, 5000);
}

/** onset bloom time constant (s): ~15 ms in the bass and middle, short in the top octaves */
export function bloomTime(note: number): number {
  const top = clamp((note - 80) / 16, 0, 1);
  const bass = clamp((48 - note) / 27, 0, 1);
  // (bass: recorded A0 rises over ~30 ms)
  return 0.0072 + 0.016 * bass * bass - 0.0052 * top;
}

function hitT60(f: number): number {
  return clamp(0.11 * Math.pow(1000 / f, 0.35), 0.025, 0.14);
}

const BODY_MODES: readonly (readonly [number, number, number])[] = [
  // Hz, T60 s, gain
  [72, 0.2, 1],
  [118, 0.16, 0.8],
  [181, 0.13, 0.7],
  [243, 0.11, 0.55],
  [330, 0.1, 0.45],
  [440, 0.08, 0.35],
  [590, 0.07, 0.3],
  [820, 0.05, 0.22],
  [1150, 0.04, 0.15],
  [1700, 0.03, 0.1],
  // high body modes are broad (heavily damped) so they add wood, not whistles
  [2250, 0.008, 0.06],
  [2900, 0.006, 0.05],
  [3700, 0.005, 0.04],
  [4800, 0.004, 0.03],
  [96, 0.18, 0.6],
  [152, 0.15, 0.55],
  [212, 0.12, 0.45],
  [287, 0.1, 0.4],
  [385, 0.09, 0.32],
  [515, 0.07, 0.26],
  [690, 0.06, 0.2],
  [980, 0.045, 0.16],
  [1400, 0.035, 0.12],
];
/** early reflections: delay (ms), gain, pan (−1 left … 1 right) */
const ER_TAPS: readonly (readonly [number, number, number])[] = [
  [6.3, 0.42, -0.6],
  [9.1, 0.36, 0.55],
  [13.7, 0.3, -0.25],
  [17.9, 0.26, 0.7],
  [23.2, 0.2, -0.75],
  [30.8, 0.15, 0.3],
];
const SYMPATHETIC_NOTES = 12;
const SYMPATHETIC_BASE = 36;

export class PianoEngine implements KeysEngine {
  private readonly sr: number;
  private p: PianoParams;
  private readonly voices: PianoVoice[] = [];
  private orderCounter = 0;
  private pedal = false;
  private bendRatio = 1;
  private readonly bufA = new Float64Array(MAX_BLOCK);
  private readonly bufB = new Float64Array(MAX_BLOCK);
  private readonly mixL = new Float64Array(MAX_BLOCK);
  private readonly mixR = new Float64Array(MAX_BLOCK);
  private readonly pulse = new Float64Array(MAX_BLOCK);
  private readonly tmpRe = new Float64Array(8 * PIANO_MAX_PARTIALS + 8);
  private readonly tmpIm = new Float64Array(8 * PIANO_MAX_PARTIALS + 8);
  private readonly tmpHas = new Uint8Array(8 * PIANO_MAX_PARTIALS + 8);
  private readonly pan = { l: 0, r: 0 };
  // soundboard
  private readonly bodyRe = new Float64Array(BODY_MODES.length);
  private readonly bodyIm = new Float64Array(BODY_MODES.length);
  private readonly bodyA = new Float64Array(BODY_MODES.length);
  private readonly bodyB = new Float64Array(BODY_MODES.length);
  private knockPending = 0;
  private thumpEnv = 0;
  private tickEnv = 0;
  private tickDecay = 0;
  private tickLp = 0;
  private tickLp2 = 0;
  /** high-pass corner of the impact noise (set by the latest strike's register) */
  private tickHpA = 0.13;
  // heavy-hammer impact: two low resonances + low-passed noise (soundboard, rim, keybed)
  private impactNoise = 0;
  private impactLp1 = 0;
  private impactLp2 = 0;
  private impactLp3 = 0;
  private readonly impactHpA: number;
  private impactDecay = 0;
  private readonly thudRe = new Float64Array(THUD_MODES.length);
  private readonly thudIm = new Float64Array(THUD_MODES.length);
  private readonly thudA = new Float64Array(THUD_MODES.length);
  private readonly thudB = new Float64Array(THUD_MODES.length);
  private thudPending = 0;
  private readonly impactLpA: number;
  private thumpDecay = 0;
  private readonly noise = new Noise(0x51a7e);
  // sympathetic strings
  private readonly combs: DelayLine[] = [];
  private readonly combDelay = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combG = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combLp = new Float64Array(SYMPATHETIC_NOTES);
  private readonly combDamp = 0.35;
  private readonly sympWet = new Smoother(0);
  private readonly lidL = new ToneFilter();
  private readonly lidR = new ToneFilter();
  private readonly master = new Smoother(0.8);
  private readonly room: FdnReverb;
  private readonly erLine: DelayLine;
  private readonly msToSamples: number;
  private weightL = 0;
  private weightR = 0;
  private readonly weightA: number;
  /** dense, short soundboard/case response: the wood colour of the string sound */
  private readonly wood: FdnReverb;
  private readonly roomLevel = new Smoother(0);
  private strikeCount = 0;

  constructor(sampleRate: number, params: PianoParams) {
    this.sr = sampleRate;
    this.p = params;
    for (let i = 0; i < POLYPHONY; i++) this.voices.push(new PianoVoice());
    for (let m = 0; m < BODY_MODES.length; m++) {
      const [f, t60] = BODY_MODES[m] as readonly [number, number, number];
      const r = Math.exp(-LN_1000 / (t60 * sampleRate));
      this.bodyA[m] = r * Math.cos((TWO_PI * f) / sampleRate);
      this.bodyB[m] = r * Math.sin((TWO_PI * f) / sampleRate);
    }
    // the in-loop one-pole adds ≈ damp/(1-damp) samples of delay; compensate so the combs stay in tune
    const lpDelay = this.combDamp / (1 - this.combDamp);
    for (let c = 0; c < SYMPATHETIC_NOTES; c++) {
      const period = sampleRate / midiToHz(SYMPATHETIC_BASE + c);
      this.combs.push(new DelayLine(Math.ceil(period) + 4));
      this.combDelay[c] = period - lpDelay;
      this.combG[c] = Math.pow(10, (-3 * period) / sampleRate / 4.5);
    }
    this.thumpDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.tickDecay = Math.exp(-1 / (0.0025 * sampleRate));
    this.impactDecay = Math.exp(-1 / (0.016 * sampleRate));
    this.impactLpA = 1 - Math.exp((-TWO_PI * 420) / sampleRate);
    this.impactHpA = 1 - Math.exp((-TWO_PI * 120) / sampleRate);
    for (let i = 0; i < THUD_MODES.length; i++) {
      const [f, t60] = THUD_MODES[i] as readonly [number, number, number, number];
      const r = Math.exp(-LN_1000 / (t60 * sampleRate));
      this.thudA[i] = r * Math.cos((TWO_PI * f) / sampleRate);
      this.thudB[i] = r * Math.sin((TWO_PI * f) / sampleRate);
    }
    // a medium recording room: short pre-delay, ~1.1 s decay, darker tail
    this.erLine = new DelayLine(Math.ceil(0.04 * sampleRate));
    this.msToSamples = sampleRate / 1000;
    this.weightA = 1 - Math.exp((-TWO_PI * 220) / sampleRate);
    // a medium-large recording room: denser, slightly moving tail (diffuse sound between the
    // partials, as in recordings) — the strings themselves stay clean
    this.room = new FdnReverb(sampleRate, 1.2);
    this.room.set(1.45, 0.95, 5600, 0.016);
    this.room.setModulation(0.6, 0.35);
    this.wood = new FdnReverb(sampleRate, 0.4);
    this.wood.set(0.16, 0.17, 11000, 0.0004);
    this.roomLevel.setTime(0.05, sampleRate);
    this.sympWet.setTime(0.25, sampleRate);
    this.master.setTime(0.02, sampleRate);
    this.setParams(params as unknown as Record<string, number>);
    this.master.value = this.master.target;
  }

  setParams(raw: Record<string, number>): void {
    const prev = this.p;
    const p = raw as unknown as PianoParams;
    this.p = p;
    this.roomLevel.target = p.room ?? 0;
    this.lidL.set(p.tone, this.sr, 0.6);
    this.lidR.set(p.tone, this.sr, 0.6);
    this.master.target = p.master;
    const retune =
      prev.sustain !== p.sustain || prev.damping !== p.damping || prev.unison !== p.unison || prev.inharm !== p.inharm || prev.stretch !== p.stretch || prev.damper !== p.damper;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (retune) this.updateCoefs(v);
      this.updatePan(v);
    }
  }

  setBend(value: number): void {
    const r = Math.pow(2, (clamp(value, -1, 1) * BEND_SEMITONES) / 12);
    if (r === this.bendRatio) return;
    this.bendRatio = r;
    for (const v of this.voices) if (v.active) this.updateCoefs(v);
  }

  setSustain(on: boolean): void {
    this.pedal = on;
    if (on) return;
    for (const v of this.voices) {
      if (v.active && v.sustained) {
        v.sustained = false;
        this.damp(v);
      }
    }
  }

  noteOn(id: number, note: number, velocity: number): void {
    const vel = clamp(velocity, 0, 1);
    // restrike: the hammer hits the string that is still vibrating
    for (const v of this.voices) {
      if (v.resonating && v.note === note) {
        v.held.add(id);
        v.sustained = false;
        v.released = false;
        v.order = ++this.orderCounter;
        this.strike(v, vel);
        return;
      }
    }
    const { index, steal } = allocateVoice(this.voices, POLYPHONY);
    const v = this.voices[index] as PianoVoice;
    if (steal && v.active) {
      v.killing = true;
      v.fadeStep = 1 / Math.max(1, 0.004 * this.sr);
      v.pendingNote = note;
      v.pendingVel = vel;
      v.pendingId = id;
      v.held.clear();
      v.order = ++this.orderCounter;
      v.released = false;
      return;
    }
    this.startVoice(v, id, note, vel);
  }

  private startVoice(v: PianoVoice, id: number, note: number, vel: number): void {
    v.active = true;
    v.killing = false;
    v.fade = 1;
    v.pendingNote = -1;
    v.note = note;
    v.n = 0;
    // fresh string: the radiated sound blooms in (restrikes of a ringing string don't)
    v.onsetPos = 0;
    // Bloom scales the middle and top; the deep bass keeps its natural, slow swell
    const bassKeep = clamp((48 - note) / 27, 0, 1);
    const scale = (this.p.bloom ?? 1) * (1 - bassKeep) + bassKeep;
    v.onsetTau = Math.max(1, this.sr * bloomTime(note) * scale);
    v.held.clear();
    v.held.add(id);
    v.sustained = false;
    v.released = false;
    v.order = ++this.orderCounter;
    this.updatePan(v);
    this.strike(v, vel);
  }

  noteOff(id: number): void {
    for (const v of this.voices) {
      if (!v.active || !v.held.remove(id) || !v.held.empty) continue;
      v.released = true;
      if (this.pedal) v.sustained = true;
      else this.damp(v);
    }
  }

  allNotesOff(): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      v.held.clear();
      v.sustained = false;
      v.released = true;
      if (v.pendingNote >= 0) v.pendingNote = -1;
      this.damp(v);
    }
  }

  panic(): void {
    for (const v of this.voices) {
      v.active = false;
      v.killing = false;
      v.pendingNote = -1;
      v.n = 0;
      v.held.clear();
    }
    this.pedal = false;
    this.bodyRe.fill(0);
    this.bodyIm.fill(0);
    this.knockPending = 0;
    this.thumpEnv = 0;
    this.tickEnv = 0;
    this.impactNoise = 0;
    this.thudPending = 0;
    this.impactLp1 = this.impactLp2 = this.impactLp3 = 0;
    this.thudRe.fill(0);
    this.thudIm.fill(0);
    for (const c of this.combs) c.clear();
    this.room.clear();
    this.wood.clear();
    this.combLp.fill(0);
  }

  activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  // -------------------------------------------------------------------------

  private updatePan(v: PianoVoice): void {
    const w = this.p.width;
    const center = w * 0.75 * clamp((v.note - 64) / 40, -1, 1);
    // partials are scattered between two radiation points (soundboard directivity)
    panGains(center - 0.55 * w, this.pan);
    v.gAL = this.pan.l;
    v.gAR = this.pan.r;
    panGains(center + 0.55 * w, this.pan);
    v.gBL = this.pan.l;
    v.gBR = this.pan.r;
  }

  private damp(v: PianoVoice): void {
    if (v.note >= PIANO_NO_DAMPER_NOTE || v.damped || v.killing) return;
    v.damped = true;
    this.updateCoefs(v);
    // the felt touching the string
    this.knockPending += this.p.releaseNoise * 0.18 * (0.3 + 0.7 * v.vel);
  }

  /** (Re)compute frequency and decay of every live resonator from the current parameters. */
  private updateCoefs(v: PianoVoice): void {
    const p = this.p;
    const note = v.note;
    const f1 = pianoFundamental(note, p.stretch);
    const B = inharmonicityB(note, p.inharm);
    // damper: fast in the treble, slower and growlier in the bass
    const bass = clamp((60 - note) / 40, 0, 1);
    // felt dampers take a moment to stop a string: ~0.15 s in the middle, longer in the bass
    const damperT60 = (0.16 + 0.55 * bass) * (1.65 - p.damper);
    const damperS = v.damped ? LN_1000 / damperT60 : 0;
    const sr = this.sr;
    const nyq = sr * 0.47;
    for (let r = 0; r < v.n; r++) {
      const id = v.pid[r] as number;
      const k = id >> 3;
      const s = id & 7;
      let f = s === S_LONG ? longitudinalFreq(note) * k * (k === 2 ? 1.01 : 1) : partialFrequency(f1, k, B);
      const t60 = s === S_LONG ? 0.45 - 0.15 * (k - 1) : partialT60(note, f, f1, p);
      let sigma = LN_1000 / t60;
      if (s === S_HIT) sigma = LN_1000 / hitT60(f);
      else if (s === S_LONG) {
        // own decay, no string detune
      } else if (k <= DOUBLE_PARTIALS) {
        const sigma1 = LN_1000 / fundamentalT60(note, p.sustain);
        const d = stringDetune(note, k, p.unison) / 2400;
        if (s === S_PROMPT) {
          // prompt and aftersound are two decay modes of the same coupled strings: (nearly) the same
          // pitch. A large offset between them made deep beat nulls that sounded like a dying pluck;
          // the shimmer comes from the third string below.
          // (the top octaves keep their classic wider split — that shimmer is what made them convincing)
          f *= Math.pow(2, d * (0.8 - 1.8 * clamp((note - 86) / 8, 0, 1)));
          // bridge coupling adds a fixed extra loss (not one that scales the high-frequency losses)
          sigma += k >= 3 && k <= 8 ? SWELL_SIGMA : (promptRate(note) - 1) * sigma1 * Math.pow(promptWeight(k), 2.2);
        } else if (s === S_AFTER) f *= Math.pow(2, d);
        else if (s === S_PHANTOM) {
          // amplitude ∝ product of two partials → decays at the sum of their rates
          f *= 2;
          sigma *= 2;
        } else {
          // third string: on either side of the other two
          const h = hash01(note + 101, k);
          // the third string sits on the other side of the pair; below the top octaves it beats
          // at its own rate per partial (top octaves: the gentle shimmer they had)
          const live = clamp((84 - note) / 12, 0, 1);
          const shimmer = f * Math.pow(2, -d * (0.5 + 0.5 * h));
          f = shimmer + live * (f - beatRate(note, k, p.unison) - shimmer);
          sigma *= 1.15;
        }
      }
      sigma += damperS * (0.6 + 0.4 * Math.min(1, f / 600));
      f *= this.bendRatio * (v.glide ? Math.pow(2, v.glide / 1200) : 1);
      if (f > nyq) f = nyq;
      const rad = Math.exp(-sigma / sr);
      const w = (TWO_PI * f) / sr;
      v.a[r] = rad * Math.cos(w);
      v.b[r] = rad * Math.sin(w);
    }
  }

  /** Hammer strike: (re)build the resonator set, keeping the state of partials still ringing. */
  private strike(v: PianoVoice, vel: number): void {
    const p = this.p;
    const note = v.note;
    const sr = this.sr;
    v.vel = vel;
    // per-strike variation (deterministic sequence, so renders are reproducible)
    const sc = ++this.strikeCount;
    const varLevel = 1 + 0.08 * (hash01(sc, 17) - 0.5);
    const varTone = 1 + 0.1 * (hash01(sc, 29) - 0.5);
    const bassG = clamp((72 - note) / 50, 0, 1);
    v.glide = vel * vel * (0.5 + 6 * bassG) * (0.8 + 0.4 * hash01(sc, 41));
    v.damped = false;
    const f1 = pianoFundamental(note, p.stretch);
    const B = inharmonicityB(note, p.inharm);
    // keep existing oscillation
    this.tmpHas.fill(0);
    for (let r = 0; r < v.n; r++) {
      const id = v.pid[r] as number;
      this.tmpHas[id] = 1;
      this.tmpRe[id] = v.re[r] as number;
      this.tmpIm[id] = v.im[r] as number;
    }
    // partial amplitudes, normalised to equal energy per note
    const fmax = Math.min(sr * 0.45, 17000);
    let count = 0;
    let energy = 0;
    const amps = this.bufA; // scratch (≤ PIANO_MAX_PARTIALS < MAX_BLOCK)
    for (let k = 1; k <= PIANO_MAX_PARTIALS; k++) {
      const f = partialFrequency(f1, k, B);
      if (f > fmax) break;
      const a = hammerSpectrum(note, k, f, f1, Math.min(1, vel * varTone), p);
      amps[k - 1] = a;
      energy += a * a;
      count = k;
    }
    const bass = clamp((60 - note) / 40, 0, 1);
    const level = (LEVEL * varLevel * Math.pow(Math.max(vel, 1e-3), p.velCurve) * (1 + 0.25 * bass)) / Math.sqrt(Math.max(energy, 1e-12));
    let n = 0;
    const peak = (amps[0] as number) * level;
    let peakA = 0;
    for (let k = 1; k <= count; k++) peakA = Math.max(peakA, (amps[k - 1] as number) * level);
    // nonlinear: harder strikes stretch the string more
    const phantomAmt = (p.metal ?? 0.5) * vel * clamp((86 - note) / 30, 0, 1);
    // the hit scales gently with velocity: soft notes are still struck, just with a softer felt
    // short treble strings: the impact is a larger part of the sound
    // the impact is as present in the bass and middle as in the (convincing) treble
    // C3–F♯4: recorded held notes start only ~1.1–1.3× brighter than their tone (a brighter
    // onset is the twang of a plucked string); from G4 up the full hit matches (1.7–1.9×)
    const midWarm = clamp((67 - note) / 5, 0, 1) * clamp((note - 40) / 6, 0, 1);
    const hitAmt = (p.hit ?? 0.6) * Math.pow(vel, 0.55) * 2.6 * (2.3 + 0.2 * hammerTreble(note)) * (1 - 0.75 * midWarm);
    const bassTilt = clamp((52 - note) / 31, 0, 1);
    // nonlinear: ∝ strike², fades out above the low middle
    const longAmt = (p.metal ?? 0.5) * vel * vel * (0.5 + 1.2 * clamp((45 - note) / 24, 0, 1)) * clamp((70 - note) / 24, 0, 1);
    const hc = hammerCorner(f1, strikeBrightness(Math.min(1, vel * varTone), p), hammerTreble(note));
    for (let k = 1; k <= count; k++) {
      const a = (amps[k - 1] as number) * level;
      // inaudible partial that isn't ringing already: skip
      if (a < peak * 1e-4 && !this.tmpHas[pidOf(k, S_AFTER)]) continue;
      const triple = k <= TRIPLE_PARTIALS;
      const double = k <= DOUBLE_PARTIALS;
      for (let s = double ? S_PROMPT : S_AFTER; s <= (triple ? S_AFTER2 : S_AFTER); s++) {
        if (n >= MAX_RES) break;
        const id = pidOf(k, s);
        v.pid[n] = id;
        v.side[n] = hash01(note * 977 + k, s + 3) < 0.5 ? 0 : 1;
        v.re[n] = this.tmpHas[id] ? (this.tmpRe[id] as number) : 0;
        v.im[n] = this.tmpHas[id] ? (this.tmpIm[id] as number) : 0;
        // positive: fast-decaying prompt part; negative (3rd–8th partials): the partial swells in
        const ps = k >= 3 && k <= 8 ? -swellAmount(note) : Math.min(0.8, promptShare(note) * promptWeight(k));
        // the third string shares what the prompt part leaves
        const a2 = ps > 0 ? Math.min(after2Share(note, k), (1 - ps) * 0.45) : after2Share(note, k);
        const after = 1 - ps - (triple ? a2 : 0);
        v.gin[n] = !double ? a : s === S_PROMPT ? a * ps : s === S_AFTER ? a * after : a * a2;
        n++;
      }
      // hit: brief extra drive of the upper partials while the hammer is in contact
      if (k >= 2 && k <= HIT_MAX && n < MAX_RES && hitAmt > 0) {
        const f = partialFrequency(f1, k, B);
        const hf = 1 / (1 + Math.pow(f / Math.max(hc.fc * 4, hc.open * 1.6), hc.slope));
        const h0 = 1 / (1 + Math.pow(f / hc.fc, hc.slope));
        // plus a little extra on the lower partials: the strike is also louder, not only brighter
        // (the hit isn't subject to the steep bass tilt of the sustained tone: heavy bass hammers still crack)
        // The hit only reads as a separate bright "tink" well above the tone; on overtones inside
        // the tone (≲ 3 kHz) it just makes the note itself fall away quickly — a pluck. So below the
        // top octaves it is confined to high frequencies, and the impact there is broadband noise instead.
        const inTone = clamp((92 - note) / 12, 0, 1);
        const band = Math.pow(clamp((f - 2500) / 4000, 0, 1), 1.5);
        const ratio = Math.min(10, (Math.max(0, hf / h0 - 1) + 0.25) * Math.pow(k, 0.5 * bassTilt)) * (1 - inTone + inTone * band);
        if (ratio > 0.05) {
          const id = pidOf(k, S_HIT);
          v.pid[n] = id;
          v.side[n] = hash01(note * 977 + k, 13) < 0.5 ? 0 : 1;
          v.re[n] = 0;
          v.im[n] = 0;
          v.gin[n] = a * hitAmt * ratio;
          n++;
        }
      }
      // longitudinal modes (k = 1, 2 → first and second mode), bass and low middle
      if (k <= 2 && longAmt > 0 && n < MAX_RES && longitudinalFreq(note) * k < fmax) {
        const id = pidOf(k, S_LONG);
        v.pid[n] = id;
        v.side[n] = k - 1;
        v.re[n] = this.tmpHas[id] ? (this.tmpRe[id] as number) : 0;
        v.im[n] = this.tmpHas[id] ? (this.tmpIm[id] as number) : 0;
        v.gin[n] = peakA * longAmt * (k === 1 ? 1 : 0.5);
        n++;
      }
      // phantom partials: strongest in the bass and middle, gone in the top octaves
      if (k >= 2 && k <= PHANTOM_MAX && n < MAX_RES && phantomAmt > 0 && 2 * partialFrequency(f1, k, B) < fmax) {
        const id = pidOf(k, S_PHANTOM);
        v.pid[n] = id;
        v.side[n] = hash01(note * 977 + k, 9) < 0.5 ? 0 : 1;
        v.re[n] = this.tmpHas[id] ? (this.tmpRe[id] as number) : 0;
        v.im[n] = this.tmpHas[id] ? (this.tmpIm[id] as number) : 0;
        v.gin[n] = a * phantomAmt * Math.min(1, a / Math.max(peakA, 1e-12));
        n++;
      }
    }
    v.n = n;
    // dispersion: rotate each resonator's excitation phase (deterministic per note and partial)
    const spread = clamp((76 - note) / 40, 0, 1);
    for (let r = 0; r < n; r++) {
      const id = v.pid[r] as number;
      const k = id >> 3;
      const phi = spread * Math.PI * (k > 1 ? 0.35 + 0.65 * hash01(note * 53 + k, 211) : 0) * Math.min(1, (k - 1) / 6);
      const g = v.gin[r] as number;
      v.gin[r] = g * Math.cos(phi);
      v.ginQ[r] = g * Math.sin(phi);
    }
    this.updateCoefs(v);
    // hammer contact: shorter and sharper for loud notes and high strings
    // contact-pulse smoothing only; the tone colour comes from hammerSpectrum()
    // contact time: a heavier hammer (Impact) stays on the string longer → rounder top, fuller strike
    // (treble hammers are small and light: barely longer)
    const heavy = (p.impact ?? 0.6) * (1 - 0.8 * trebleness(note));
    const tauSec = (0.000012 + 0.00005 * (1 - vel) * (1 - vel) + 0.00011 * heavy) * Math.pow(262 / f1, 0.2);
    const tau = Math.max(0.6, tauSec * sr);
    v.pulseTau = tau;
    v.pulseLen = Math.ceil(9 * tau) + 1;
    let norm = 0;
    for (let j = 0; j < v.pulseLen; j++) norm += j * Math.exp(-j / tau);
    v.pulseNorm = 1 / norm;
    v.pulsePos = 0;
    // hammer knock into the soundboard
    // key bottoming and the hammer knock through the wooden action and soundboard:
    // a big part of what makes a struck key sound like a key (most audible in the treble)
    // the woody part of the key/action knock; in the top octaves the impact is mostly a bright tick (below)
    // (bass: no thump spike ahead of the string — recorded low notes start ~12 dB under their swell)
    this.knockPending += p.hammerNoise * Math.pow(vel, 1.1) * (1.5 - 1.1 * bass) * (1 - 0.55 * trebleness(note));
    this.thumpEnv += p.hammerNoise * vel * vel * 0.02;
    // treble: the hard hammer core hitting steel gives a short, bright "tick"
    // broadband impact noise: felt + action; lower and fuller in the bass and middle, a bright tick up top
    // the small bright click: much quieter than before (recordings: little energy above 6 kHz)
    this.tickEnv += p.hammerNoise * Math.pow(vel, 1.2) * (0.16 - 0.14 * bass - 0.055 * trebleness(note));
    this.tickHpA = 0.04 + 0.09 * trebleness(note);
    // a heavy felt hammer moves the whole instrument: a low thud (recorded notes carry 40–160 Hz
    // energy at −13…−16 dB in the first 30 ms, even C5)
    const noteLevel = LEVEL * Math.pow(Math.max(vel, 1e-3), p.velCurve);
    // (deep bass: its own low partials already carry the low end; recorded A0's strike is a high clang)
    const deep = Math.min(1, Math.max(0, (33 - note) / 12));
    const impact = (p.impact ?? 0.6) * noteLevel * (1 - 0.45 * bass - 0.4 * deep - 0.7 * trebleness(note));
    this.impactNoise += impact * 1.3;
    this.thudPending += impact * 0.6;
  }

  // -------------------------------------------------------------------------

  private renderVoice(v: PianoVoice, n: number): void {
    // tension modulation settles: retune while the pitch glide is audible
    if (v.glide !== 0) {
      v.glide = v.glide > 0.05 ? v.glide * Math.exp(-n / (0.09 * this.sr)) : 0;
      this.updateCoefs(v);
    }
    const A = this.bufA;
    const Bf = this.bufB;
    A.fill(0, 0, n);
    Bf.fill(0, 0, n);
    const hasPulse = v.pulsePos < v.pulseLen;
    if (hasPulse) {
      const pulse = this.pulse;
      for (let i = 0; i < n; i++) {
        const j = v.pulsePos + i;
        pulse[i] = j < v.pulseLen ? j * Math.exp(-j / v.pulseTau) * v.pulseNorm : 0;
      }
      v.pulsePos += n;
    }
    const pulse = this.pulse;
    let r = 0;
    while (r < v.n) {
      let re = v.re[r] as number;
      let im = v.im[r] as number;
      const a = v.a[r] as number;
      const b = v.b[r] as number;
      const dst = v.side[r] ? Bf : A;
      if (hasPulse) {
        const g = v.gin[r] as number;
        const gq = v.ginQ[r] as number;
        for (let i = 0; i < n; i++) {
          const x = pulse[i] as number;
          const nr = a * re - b * im + g * x;
          im = b * re + a * im + gq * x;
          re = nr;
          dst[i] = (dst[i] as number) + im;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const nr = a * re - b * im;
          im = b * re + a * im;
          re = nr;
          dst[i] = (dst[i] as number) + im;
        }
      }
      if (!hasPulse && re * re + im * im < DEAD_ENERGY) {
        // swap-remove the dead resonator
        const last = v.n - 1;
        v.pid[r] = v.pid[last] as number;
        v.re[r] = v.re[last] as number;
        v.im[r] = v.im[last] as number;
        v.a[r] = v.a[last] as number;
        v.b[r] = v.b[last] as number;
        v.gin[r] = v.gin[last] as number;
        v.ginQ[r] = v.ginQ[last] as number;
        v.side[r] = v.side[last] as number;
        v.n = last;
        continue;
      }
      v.re[r] = re;
      v.im[r] = im;
      r++;
    }
    const L = this.mixL;
    const R = this.mixR;
    if (v.killing) {
      let fade = v.fade;
      for (let i = 0; i < n; i++) {
        fade = Math.max(0, fade - v.fadeStep);
        const x = A[i] as number;
        const y = Bf[i] as number;
        L[i] = (L[i] as number) + (x * v.gAL + y * v.gBL) * fade;
        R[i] = (R[i] as number) + (x * v.gAR + y * v.gBR) * fade;
      }
      v.fade = fade;
      if (fade <= 0) {
        v.active = false;
        v.killing = false;
        v.n = 0;
        if (v.pendingNote >= 0) this.startVoice(v, v.pendingId, v.pendingNote, v.pendingVel);
      }
      return;
    }
    if (v.onsetPos < 8 * v.onsetTau) {
      // starts at ~20 % (the hammer's own transient stays audible) and blooms to full level
      let pos = v.onsetPos;
      const inv = 1 / v.onsetTau;
      for (let i = 0; i < n; i++, pos++) {
        const g = 1 - 0.8 * Math.exp(-pos * inv);
        const x = (A[i] as number) * g;
        const y = (Bf[i] as number) * g;
        L[i] = (L[i] as number) + x * v.gAL + y * v.gBL;
        R[i] = (R[i] as number) + x * v.gAR + y * v.gBR;
      }
      v.onsetPos = pos;
    } else {
      for (let i = 0; i < n; i++) {
        const x = A[i] as number;
        const y = Bf[i] as number;
        L[i] = (L[i] as number) + x * v.gAL + y * v.gBL;
        R[i] = (R[i] as number) + x * v.gAR + y * v.gBR;
      }
    }
    if (v.n === 0 && !hasPulse) {
      v.active = false;
      v.held.clear();
    }
  }

  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const n = count;
    const L = this.mixL;
    const R = this.mixR;
    L.fill(0, 0, n);
    R.fill(0, 0, n);
    for (const v of this.voices) if (v.active) this.renderVoice(v, n);

    const p = this.p;
    const bodyFeed = 0.06 * p.body;
    const modes = BODY_MODES.length;
    // these resonators are low strings (C2–B2): they ring along when the pedal lifts the dampers;
    // without it only a trace (on a real piano only the top strings are undamped)
    this.sympWet.target = p.resonance * (this.pedal ? 0.5 : 0.03);
    const noise = this.noise;
    for (let i = 0; i < n; i++) {
      const l = L[i] as number;
      const r = R[i] as number;
      const mono = 0.5 * (l + r);
      // --- soundboard / hammer knock
      let knock = 0;
      if (i === 0 && this.knockPending) {
        knock = this.knockPending;
        this.knockPending = 0;
      }
      let thump = 0;
      if (this.thumpEnv > 1e-7) {
        thump = noise.next() * this.thumpEnv;
        this.thumpEnv *= this.thumpDecay;
      }
      // heavy-hammer impact: low-passed noise burst + two decaying low resonances
      let imp = 0;
      let impL = 0;
      let impR = 0;
      if (this.impactNoise > 1e-7) {
        const nz = noise.next() * this.impactNoise;
        this.impactLp1 += (nz - this.impactLp1) * this.impactLpA;
        this.impactLp2 += (this.impactLp1 - this.impactLp2) * this.impactLpA;
        // band-pass (~150–320 Hz): the felt's body, not a rumble — the lowest part is the thud below
        this.impactLp3 += (this.impactLp2 - this.impactLp3) * this.impactHpA;
        imp = (this.impactLp2 - this.impactLp3) * 6;
        this.impactNoise *= this.impactDecay;
      }
      const tk = i === 0 ? this.thudPending : 0;
      if (i === 0) this.thudPending = 0;
      for (let m = 0; m < THUD_MODES.length; m++) {
        const re = this.thudRe[m] as number;
        const im = this.thudIm[m] as number;
        if (re === 0 && im === 0 && tk === 0) continue;
        const nr = (this.thudA[m] as number) * re - (this.thudB[m] as number) * im + tk;
        const ni = (this.thudB[m] as number) * re + (this.thudA[m] as number) * im;
        this.thudRe[m] = Math.abs(nr) < 1e-9 && Math.abs(ni) < 1e-9 ? 0 : nr;
        this.thudIm[m] = Math.abs(nr) < 1e-9 && Math.abs(ni) < 1e-9 ? 0 : ni;
        // the case and board radiate from different places: a wide, room-filling thud
        const [, , w, pan] = THUD_MODES[m] as readonly [number, number, number, number];
        impL += ni * w * (1 - pan);
        impR += ni * w * (1 + pan);
      }
      let tick = 0;
      if (this.tickEnv > 1e-7) {
        // high-passed noise burst (one-pole low-pass subtracted)
        const nz = noise.next();
        // band-limited (~1–8 kHz) impact noise: felt on steel plus the key action
        this.tickLp += (nz - this.tickLp) * this.tickHpA;
        const hp = nz - this.tickLp;
        this.tickLp2 += (hp - this.tickLp2) * 0.4;
        tick = this.tickLp2 * this.tickEnv;
        this.tickEnv *= this.tickDecay;
      }
      const bin = knock + mono * bodyFeed + thump * 0.3;
      let bodyL = 0;
      let bodyR = 0;
      for (let m = 0; m < modes; m++) {
        const re = this.bodyRe[m] as number;
        const im = this.bodyIm[m] as number;
        const a = this.bodyA[m] as number;
        const b = this.bodyB[m] as number;
        const nr = a * re - b * im + bin;
        const ni = b * re + a * im;
        this.bodyRe[m] = nr;
        this.bodyIm[m] = ni;
        const g = (BODY_MODES[m] as readonly [number, number, number])[2] * ni;
        if (m & 1) bodyR += g;
        else bodyL += g;
      }
      // body modes are narrow; scale so a forte knock is a soft thud
      const bodyGain = 0.035;
      // --- sympathetic strings
      const wet = this.sympWet.next();
      let sL = 0;
      let sR = 0;
      if (wet > 1e-4) {
        const cin = mono * 0.03;
        for (let c = 0; c < SYMPATHETIC_NOTES; c++) {
          const line = this.combs[c] as DelayLine;
          const x = line.read(this.combDelay[c] as number);
          const lp = x + ((this.combLp[c] as number) - x) * this.combDamp;
          this.combLp[c] = lp;
          const y = cin + (this.combG[c] as number) * lp;
          line.write(y);
          if (c & 1) sR += y;
          else sL += y;
        }
      }
      // soundboard: the strings are heard through a dense wooden resonator
      this.wood.process(l, r);
      const woodAmt = p.body * WOOD_GAIN;
      const outl = l + this.wood.outL * woodAmt + (bodyL * 0.8 + bodyR * 0.2) * bodyGain + thump * 0.15 + tick + imp + impL + sL * wet;
      const outr = r + this.wood.outR * woodAmt + (bodyR * 0.8 + bodyL * 0.2) * bodyGain + thump * 0.15 + tick + imp + impR + sR * wet;
      const g = this.master.next();
      // early reflections (stereo, 6–31 ms): the instrument sits in a space instead of in your ear
      this.erLine.write(0.5 * (outl + outr));
      let erL = 0;
      let erR = 0;
      for (let t = 0; t < ER_TAPS.length; t++) {
        const [ms, gain, pan] = ER_TAPS[t] as readonly [number, number, number];
        const v = this.erLine.read(ms * this.msToSamples) * gain;
        erL += v * (1 - pan);
        erR += v * (1 + pan);
      }
      const er = (p.room ?? 0) * 0.5;
      // weight: a gentle low-mid lift (~+2.5 dB below ~220 Hz)
      this.weightL += (outl - this.weightL) * this.weightA;
      this.weightR += (outr - this.weightR) * this.weightA;
      let ol = this.lidL.process(outl + this.weightL * 0.33 + erL * er);
      let or = this.lidR.process(outr + this.weightR * 0.33 + erR * er);
      const rl = this.roomLevel.next();
      if (rl > 1e-4) {
        this.room.process(ol, or);
        ol += this.room.outL * rl * 0.62;
        or += this.room.outR * rl * 0.62;
      }
      outL[offset + i] = (outL[offset + i] as number) + ol * g;
      outR[offset + i] = (outR[offset + i] as number) + or * g;
    }
  }
}
