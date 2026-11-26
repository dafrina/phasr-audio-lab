/**
 * Arp / Step sequencer — pure logic shared by playback, export, live input,
 * the UI and tests.
 *
 * A track with the tool keeps the keys you hold (clip notes or live keys);
 * every step of the song grid turns the keys held at that moment into notes:
 *  - Arp: the held notes one after another (up, down, up-down, random, as
 *    played) across 1–4 octaves.
 *  - Step sequencer: a 1–16 step pattern (velocity, accent, slide, tie,
 *    ratchet, probability, per-step transpose) played on the held key(s) —
 *    hold C and the line plays in C, press F and it moves to F.
 * Steps sit on the song grid (bar-aligned), so patterns stay locked to the
 * beat; swing delays every second step.
 */

export type ArpDirection = 'up' | 'down' | 'updown' | 'random' | 'played';
export type ArpMode = 'arp' | 'seq';

export interface SeqStep {
  on: boolean;
  /** 0..1 */
  vel: number;
  accent: boolean;
  /** overlaps into the next step, so mono synths (808, Acid) glide */
  slide: boolean;
  /** joins the next step into one long note */
  tie: boolean;
  /** 1–4 hits inside the step (rolls) */
  ratchet: number;
  /** 0..1 chance the step plays (deterministic per position) */
  prob: number;
  /** semitones added to the held key (−24..24) */
  transpose: number;
}

export interface ArpConfig {
  enabled: boolean;
  mode: ArpMode;
  direction: ArpDirection;
  /** 1..4 */
  octaves: number;
  /** step length in beats (quarter notes): 0.125 = 1/32 … 1 = 1/4 */
  rate: number;
  /** 0.05..1 of the step */
  gate: number;
  /** 0..0.75: every second step moves later by this fraction of a step */
  swing: number;
  /** live: keep playing after the keys are let go */
  latch: boolean;
  /** sequencer pattern length 1..16 */
  length: number;
  steps: SeqStep[];
  presetName: string;
}

export const SEQ_STEPS = 16;

export const ARP_RATES: { value: number; label: string }[] = [
  { value: 0.125, label: '1/32' },
  { value: 1 / 6, label: '1/16T' },
  { value: 0.25, label: '1/16' },
  { value: 1 / 3, label: '1/8T' },
  { value: 0.5, label: '1/8' },
  { value: 1, label: '1/4' },
];

export const ARP_DIRECTIONS: { value: ArpDirection; label: string }[] = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'updown', label: 'Up-Down' },
  { value: 'random', label: 'Random' },
  { value: 'played', label: 'As played' },
];

export function defaultStep(on = false): SeqStep {
  return { on, vel: 0.8, accent: false, slide: false, tie: false, ratchet: 1, prob: 1, transpose: 0 };
}

export function defaultArp(): ArpConfig {
  return {
    enabled: true,
    mode: 'arp',
    direction: 'up',
    octaves: 2,
    rate: 0.25,
    gate: 0.6,
    swing: 0,
    latch: false,
    length: 16,
    steps: Array.from({ length: SEQ_STEPS }, (_, i) => defaultStep(i % 2 === 0)),
    presetName: 'Up 1/16 × 2 oct',
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

type StepSpec = Partial<SeqStep> | null;
function pattern(spec: StepSpec[]): SeqStep[] {
  return Array.from({ length: SEQ_STEPS }, (_, i) => {
    const s = spec[i % spec.length];
    return s ? { ...defaultStep(true), ...s } : defaultStep(false);
  });
}
const x: StepSpec = {};
const _: StepSpec = null;

export const ARP_PRESETS: ArpConfig[] = [
  { ...defaultArp() },
  { ...defaultArp(), presetName: 'Up-Down 1/16 × 3 oct', direction: 'updown', octaves: 3 },
  { ...defaultArp(), presetName: 'Down 1/8 × 1 oct', direction: 'down', octaves: 1, rate: 0.5, gate: 0.8 },
  { ...defaultArp(), presetName: 'Random Sparkle 1/16', direction: 'random', octaves: 3, gate: 0.35 },
  { ...defaultArp(), presetName: 'As Played 1/8T', direction: 'played', octaves: 1, rate: 1 / 3, gate: 0.7 },
  { ...defaultArp(), presetName: 'Berlin School 1/16', direction: 'up', octaves: 2, gate: 0.45, swing: 0 },
  // step sequencer patterns
  { ...defaultArp(), mode: 'seq', presetName: 'Trance Gate 1/16', rate: 0.25, gate: 0.55, length: 16, steps: pattern([x, x, _, x, x, _, x, _, x, x, _, x, x, _, x, x]) },
  {
    ...defaultArp(),
    mode: 'seq',
    presetName: 'Acid 303 Line',
    rate: 0.25,
    gate: 0.5,
    length: 16,
    steps: pattern([
      { accent: true },
      { transpose: 12, slide: true },
      x,
      _,
      { transpose: 12 },
      { transpose: 10, slide: true },
      { accent: true, transpose: 7 },
      x,
      _,
      x,
      { transpose: 12, accent: true },
      { slide: true },
      { transpose: 3 },
      _,
      { transpose: 5, accent: true },
      { transpose: 7, slide: true },
    ]),
  },
  {
    ...defaultArp(),
    mode: 'seq',
    presetName: 'House Offbeat Stab',
    rate: 0.25,
    gate: 0.35,
    length: 4,
    steps: pattern([_, _, { accent: true }, _]),
  },
  {
    ...defaultArp(),
    mode: 'seq',
    presetName: 'Rolling Bass 1/16',
    rate: 0.25,
    gate: 0.45,
    length: 4,
    steps: pattern([_, { vel: 0.9 }, { vel: 0.7 }, { vel: 0.8 }]),
  },
  {
    ...defaultArp(),
    mode: 'seq',
    presetName: 'Trap Hat Rolls',
    rate: 0.25,
    gate: 0.4,
    length: 16,
    steps: pattern([x, x, x, x, x, { ratchet: 2 }, x, x, x, x, { ratchet: 3, vel: 0.6 }, x, x, { ratchet: 4, vel: 0.55 }, x, { ratchet: 2 }]),
  },
  {
    ...defaultArp(),
    mode: 'seq',
    presetName: '808 Slide Line',
    rate: 0.25,
    gate: 0.9,
    length: 16,
    steps: pattern([{ tie: true }, x, _, x, { tie: true }, x, { slide: true }, { transpose: 7 }, _, _, { transpose: 3, slide: true }, { transpose: 5 }, _, x, { slide: true }, { transpose: -2 }]),
  },
];

export function arpPreset(name: string): ArpConfig | undefined {
  return ARP_PRESETS.find((p) => p.presetName === name);
}

// ---------------------------------------------------------------------------
// Sanitizing saved data
// ---------------------------------------------------------------------------

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeArp(raw: unknown): ArpConfig | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = defaultArp();
  const stepsIn = Array.isArray(r.steps) ? (r.steps as unknown[]) : [];
  return {
    enabled: r.enabled !== false,
    mode: r.mode === 'seq' ? 'seq' : 'arp',
    direction: ARP_DIRECTIONS.some((x) => x.value === r.direction) ? (r.direction as ArpDirection) : d.direction,
    octaves: Math.round(num(r.octaves, 1, 4, d.octaves)),
    rate: ARP_RATES.some((x) => Math.abs(x.value - (r.rate as number)) < 1e-6) ? (r.rate as number) : d.rate,
    gate: num(r.gate, 0.05, 1, d.gate),
    swing: num(r.swing, 0, 0.75, d.swing),
    latch: r.latch === true,
    length: Math.round(num(r.length, 1, SEQ_STEPS, d.length)),
    steps: Array.from({ length: SEQ_STEPS }, (_, i) => {
      const s = stepsIn[i];
      if (!s || typeof s !== 'object') return defaultStep(false);
      const q = s as Record<string, unknown>;
      return {
        on: q.on === true,
        vel: num(q.vel, 0, 1, 0.8),
        accent: q.accent === true,
        slide: q.slide === true,
        tie: q.tie === true,
        ratchet: Math.round(num(q.ratchet, 1, 4, 1)),
        prob: num(q.prob, 0, 1, 1),
        transpose: Math.round(num(q.transpose, -24, 24, 0)),
      };
    }),
    presetName: typeof r.presetName === 'string' ? r.presetName.slice(0, 40) : 'Custom',
  };
}

// ---------------------------------------------------------------------------
// The step engine
// ---------------------------------------------------------------------------

export interface HeldNote {
  pitch: number;
  /** 1..127 */
  velocity: number;
  /** when it was pressed (orders "as played") */
  order: number;
}

export interface ArpNote {
  pitch: number;
  /** ticks from the step's grid position (swing / ratchets) */
  offset: number;
  length: number;
  /** 1..127 */
  velocity: number;
}

function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** the arp's note list for a held set: sorted / ordered, spread over the octaves */
function arpCycle(cfg: ArpConfig, held: readonly HeldNote[]): HeldNote[] {
  const base = cfg.direction === 'played' ? [...held].sort((a, b) => a.order - b.order) : [...held].sort((a, b) => a.pitch - b.pitch);
  const out: HeldNote[] = [];
  for (let o = 0; o < cfg.octaves; o++) for (const h of base) if (h.pitch + 12 * o <= 127) out.push({ ...h, pitch: h.pitch + 12 * o });
  if (cfg.direction === 'down') out.reverse();
  if (cfg.direction === 'updown' && out.length > 2) {
    // up then down without repeating the ends
    for (let i = out.length - 2; i > 0; i--) out.push(out[i] as HeldNote);
  }
  return out;
}

/**
 * Notes for one step. `absStep` = the step's index on the song grid (0 = bar 1);
 * `sinceChange` = steps since the held set last changed (the arp starts its cycle there);
 * `stepTicks` = step length in ticks.
 */
export function stepNotes(cfg: ArpConfig, held: readonly HeldNote[], absStep: number, sinceChange: number, stepTicks: number): ArpNote[] {
  if (!held.length) return [];
  const swing = absStep % 2 === 1 ? cfg.swing * stepTicks * 0.5 : 0;
  if (cfg.mode === 'arp') {
    const cyc = arpCycle(cfg, held);
    if (!cyc.length) return [];
    const h = cfg.direction === 'random' ? (cyc[Math.floor(hash01(absStep, 911) * cyc.length)] as HeldNote) : (cyc[sinceChange % cyc.length] as HeldNote);
    return [{ pitch: h.pitch, offset: swing, length: Math.max(1, stepTicks * cfg.gate), velocity: h.velocity }];
  }
  // sequencer: the pattern is locked to the song grid
  const len = Math.max(1, Math.min(SEQ_STEPS, cfg.length));
  const i = ((absStep % len) + len) % len;
  const st = cfg.steps[i];
  if (!st || !st.on) return [];
  if (st.prob < 1 && hash01(absStep, 4243) >= st.prob) return [];
  // how far a tie carries this note (into following tied steps)
  let span = 1;
  for (let k = i, guard = 0; guard < len - 1; guard++) {
    const cur = cfg.steps[k];
    const nx = cfg.steps[(k + 1) % len];
    if (!cur?.tie || !nx?.on) break;
    span++;
    k = (k + 1) % len;
  }
  const prev = cfg.steps[(i - 1 + len) % len];
  // a step that a tie runs into doesn't strike again
  if (prev?.on && prev.tie && len > 1) return [];
  const vel = (h: HeldNote) => Math.max(1, Math.min(127, Math.round(h.velocity * (0.35 + 0.65 * st.vel) * (st.accent ? 1.25 : 1))));
  const r = Math.max(1, Math.min(4, st.ratchet));
  const out: ArpNote[] = [];
  for (const h of held) {
    const pitch = h.pitch + st.transpose;
    if (pitch < 0 || pitch > 127) continue;
    if (r > 1) {
      for (let k = 0; k < r; k++) out.push({ pitch, offset: swing + (k * stepTicks) / r, length: Math.max(1, (stepTicks / r) * Math.min(0.9, cfg.gate)), velocity: Math.max(1, vel(h) - k * 6) });
      continue;
    }
    // slide: overlap the next step a little (mono synths glide); tie: one long note
    const length = st.slide ? stepTicks * span * 1.15 : span > 1 ? stepTicks * (span - 1) + stepTicks * cfg.gate : stepTicks * cfg.gate;
    out.push({ pitch, offset: swing, length: Math.max(1, length), velocity: vel(h) });
  }
  return out;
}

export interface TimedNote {
  pitch: number;
  start: number;
  length: number;
  velocity: number;
}

/**
 * Expand held notes (absolute ticks) into the tool's output between `from` and
 * `to` (absolute ticks, steps are on the song grid). Output notes are clipped to `to`.
 */
export function expandHeld(cfg: ArpConfig, held: readonly TimedNote[], from: number, to: number, ppq: number): TimedNote[] {
  const stepTicks = Math.max(1, Math.round(cfg.rate * ppq));
  const out: TimedNote[] = [];
  const first = Math.ceil(from / stepTicks - 1e-9);
  let lastKey = '';
  let since = 0;
  for (let s = first; s * stepTicks < to; s++) {
    const t = s * stepTicks;
    const now = held.filter((n) => n.start <= t + 1e-6 && n.start + n.length > t + 1e-6);
    const key = now.map((n) => n.pitch).sort((a, b) => a - b).join(',');
    if (key !== lastKey) {
      since = 0;
      lastKey = key;
    }
    const hn: HeldNote[] = now.map((n, i) => ({ pitch: n.pitch, velocity: n.velocity, order: n.start * 1000 + i }));
    for (const e of stepNotes(cfg, hn, s, since, stepTicks)) {
      const start = t + e.offset;
      if (start >= to) continue;
      out.push({ pitch: e.pitch, start, length: Math.max(1, Math.min(e.length, to - start)), velocity: e.velocity });
    }
    since++;
  }
  return out;
}
