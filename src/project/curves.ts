/**
 * Shapes of automation segments (the stretch from one point to the next) and
 * how playback follows them.
 *
 * A shape maps x ∈ [0, 1] (how far through the segment, in time) to the fraction
 * of the way from the segment's start value to its end value. The fraction is
 * taken in the lane's own display space: linear for most parameters, logarithmic
 * for exp-curve ones (frequency, times), so a lane draws exactly what plays and a
 * "linear" frequency segment stays an exponential ramp.
 *
 *  - linear (no shape stored): x
 *  - curve, amount −1…+1: + = slow then fast, − = fast then slow, 0 = linear
 *  - s, steepness −1…+1 and bend 0…1: two curves meeting at the bend point, which
 *    lies on the straight line (so steepness 0 is exactly linear, and the S can be
 *    lopsided); + = slow–fast–slow (≈ a smooth step at +1), − = fast–flat–fast
 *  - hold: the start value until the next point, then a jump
 *
 * Every curve piece is a scaled exponential e(k, u) = (e^{ku} − 1)/(e^k − 1): exact
 * at both ends, monotonic, and convex or concave on its own, which gives the
 * exact chord error used to subdivide it for playback (`shapeBreaks`).
 */

export type AutomationShape =
  | { type: 'curve'; amount: number }
  | { type: 's'; steepness: number; bend: number }
  | { type: 'hold' };

export type ShapeType = 'linear' | AutomationShape['type'];

/** amount ±1 → exponent ±5: the curve's midpoint sits 7.6 % (or 92.4 %) of the way */
export const CURVE_K = 5;
/** steepness ±1 → exponent ±24 on each side of the bend (10 %→90 % within 7 % of the segment) */
export const S_K = 24;

/** the parameter-spec fields that decide the domain: exp-curve specs with min > 0 interpolate in log space */
export interface ShapeDomain {
  curve: 'linear' | 'exp';
  min: number;
  max: number;
}

export function isExpDomain(spec: ShapeDomain | null | undefined): boolean {
  return !!spec && spec.curve === 'exp' && spec.min > 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** e(k, u) = (e^{ku} − 1)/(e^k − 1), = u when k → 0 */
function expo(k: number, u: number): number {
  return Math.abs(k) < 1e-9 ? u : Math.expm1(k * u) / Math.expm1(k);
}

/** the exponent of an S's two halves for a steepness (squared, for fine control near straight) */
export function sExponent(steepness: number): number {
  const s = clamp(steepness, -1, 1);
  return S_K * s * Math.abs(s);
}

/** True when the shape plays (and draws) exactly as a straight segment. */
export function isLinearShape(shape: AutomationShape | undefined): boolean {
  return !shape || (shape.type === 'curve' && shape.amount === 0) || (shape.type === 's' && shape.steepness === 0);
}

/** Fraction of the way from the start to the end value at x ∈ [0, 1] of the segment. */
export function shapeFrac(shape: AutomationShape | undefined, x: number): number {
  const u = clamp(x, 0, 1);
  if (!shape) return u;
  switch (shape.type) {
    case 'hold':
      return u < 1 ? 0 : 1;
    case 'curve':
      return expo(CURVE_K * clamp(shape.amount, -1, 1), u);
    case 's': {
      const b = clamp(shape.bend, 0, 1);
      const k = sExponent(shape.steepness);
      if (u < b) return b * expo(k, u / b);
      if (b >= 1) return 1;
      return b + (1 - b) * expo(-k, (u - b) / (1 - b));
    }
  }
}

/** a value `f` of the way from a to b, in the domain's display space */
export function lerpDomain(a: number, b: number, f: number, exp: boolean): number {
  if (f <= 0) return a;
  if (f >= 1) return b;
  return exp && a > 0 && b > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
}

/** a value's position 0..1 in the domain (log for exp specs), as the lane draws it */
export function domainPos(spec: ShapeDomain, v: number): number {
  if (isExpDomain(spec)) return Math.log(Math.max(spec.min, v) / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}

// ---------------------------------------------------------------------------
// Playback: subdivision into linear ramps with a bounded error
// ---------------------------------------------------------------------------

/** Largest deviation between a played segment and its exact shape (fraction of the parameter's range). */
export const PLAYBACK_EPS = 1e-3;
/** Largest change one sub-ramp may make (fraction of the range): keeps the ramp type of the target
 * (linear in gain for volume, exponential for frequency) from adding error between breakpoints. */
export const PLAYBACK_MAX_STEP = 1 / 32;

/**
 * Exact maximum distance between e(k, ·) and its chord over [u0, u1]. e is convex or
 * concave, so the distance peaks where its slope equals the chord's: e'(u) = k e^{ku}/(e^k − 1).
 */
export function chordError(k: number, u0: number, u1: number): number {
  if (Math.abs(k) < 1e-9 || u1 <= u0) return 0;
  const f0 = expo(k, u0);
  const f1 = expo(k, u1);
  const c = (f1 - f0) / (u1 - u0);
  const arg = (c * Math.expm1(k)) / k;
  if (!(arg > 0)) return 0;
  const us = clamp(Math.log(arg) / k, u0, u1);
  return Math.abs(f0 + c * (us - u0) - expo(k, us));
}

interface Piece {
  /** segment x where the piece starts / ends */
  x0: number;
  x1: number;
  /** fraction at the piece's start, and how much of the fraction it covers */
  y0: number;
  dy: number;
  k: number;
}

function pieces(shape: AutomationShape): Piece[] {
  if (shape.type === 'curve') return [{ x0: 0, x1: 1, y0: 0, dy: 1, k: CURVE_K * clamp(shape.amount, -1, 1) }];
  if (shape.type === 's') {
    const b = clamp(shape.bend, 0, 1);
    const k = sExponent(shape.steepness);
    const out: Piece[] = [];
    if (b > 0) out.push({ x0: 0, x1: b, y0: 0, dy: b, k });
    if (b < 1) out.push({ x0: b, x1: 1, y0: b, dy: 1 - b, k: -k });
    return out;
  }
  return [];
}

/**
 * Interior breakpoints (x in (0, 1), ascending) such that straight lines between
 * them stay within `eps` of the shape and no line changes the value by more than
 * `maxStep` — both in fractions of the parameter's range, for a segment that spans
 * `span` of the range. Linear and hold shapes need none.
 */
export function shapeBreaks(shape: AutomationShape, span: number, eps = PLAYBACK_EPS, maxStep = PLAYBACK_MAX_STEP): number[] {
  if (isLinearShape(shape) || shape.type === 'hold' || !(span > 0)) return [];
  const out: number[] = [];
  const ps = pieces(shape);
  for (let pi = 0; pi < ps.length; pi++) {
    const p = ps[pi] as Piece;
    const scale = p.dy * span;
    const split = (u0: number, u1: number, depth: number) => {
      const ok = depth >= 16 || (chordError(p.k, u0, u1) * scale <= eps && (expo(p.k, u1) - expo(p.k, u0)) * scale <= maxStep);
      if (ok) return;
      const um = (u0 + u1) / 2;
      split(u0, um, depth + 1);
      out.push(p.x0 + um * (p.x1 - p.x0));
      split(um, u1, depth + 1);
    };
    split(0, 1, 0);
    // the bend itself is a breakpoint (where the two halves meet)
    if (pi < ps.length - 1) out.push(p.x1);
  }
  return out;
}

/** a shape's amount-like value in −1…1 (curve amount, S steepness; 0 for linear / hold) */
export function shapeAmount(shape: AutomationShape | undefined): number {
  if (!shape) return 0;
  return shape.type === 'curve' ? shape.amount : shape.type === 's' ? shape.steepness : 0;
}

/** Where on the segment the curve handle sits (x 0..1): the middle, or an S's bend. */
export function handleX(shape: AutomationShape | undefined): number {
  return shape?.type === 's' ? clamp(shape.bend, 0, 1) : 0.5;
}

/** Sticky zone around `at` while dragging: within ±width it snaps there. */
export function detent(v: number, at = 0, width = 0.04): number {
  return Math.abs(v - at) < width ? at : v;
}

/**
 * The curve amount whose midpoint sits `m` of the way (0..1) from the start value to
 * the end value: the inverse of the curve at x = ½ (e(k, ½) = 1/(e^{k/2} + 1)).
 */
export function curveAmountForMid(m: number): number {
  const mm = clamp(m, 1e-6, 1 - 1e-6);
  return clamp((2 * Math.log((1 - mm) / mm)) / CURVE_K, -1, 1);
}

/** A tidy stored form: an exactly straight curve is no shape (linear); values clamped. */
export function normalizeShape(shape: AutomationShape | undefined): AutomationShape | undefined {
  if (!shape) return undefined;
  if (shape.type === 'curve') {
    const amount = clamp(shape.amount, -1, 1);
    return amount === 0 ? undefined : { type: 'curve', amount };
  }
  if (shape.type === 's') return { type: 's', steepness: clamp(shape.steepness, -1, 1), bend: clamp(shape.bend, 0, 1) };
  return { type: 'hold' };
}

/** Validate an untrusted stored shape (null / anything unknown = linear). */
export function sanitizeShape(raw: unknown): AutomationShape | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (r.type === 'curve') return normalizeShape({ type: 'curve', amount: num(r.amount, 0) });
  if (r.type === 's') return normalizeShape({ type: 's', steepness: num(r.steepness, 0), bend: num(r.bend, 0.5) });
  if (r.type === 'hold') return { type: 'hold' };
  return undefined;
}

const pct = (v: number, plus: boolean) => `${v < 0 && Math.round(-v * 100) > 0 ? '−' : plus && Math.round(v * 100) > 0 ? '+' : ''}${Math.round(Math.abs(v) * 100)}%`;

/** The readout while bending: "Curve +40%", "S 60% · bend at 70%", "Linear", "Hold". */
export function shapeLabel(shape: AutomationShape | undefined): string {
  if (!shape || (shape.type === 'curve' && isLinearShape(shape))) return 'Linear';
  if (shape.type === 'curve') return `Curve ${pct(shape.amount, true)}`;
  if (shape.type === 's') return `S ${pct(shape.steepness, false)} · bend at ${Math.round(clamp(shape.bend, 0, 1) * 100)}%`;
  return 'Hold';
}
