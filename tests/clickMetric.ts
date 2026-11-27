/** The click metric (tests/clicks.test.ts, tests/stretch.test.ts): a click is a sample-to-sample step the steady signal never makes. */
const SR = 48000;

/** largest |x[n] − x[n−1]| between two times (seconds, at 48 kHz) */
export function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, Math.round(from * SR)); i < Math.min(x.length, Math.round(to * SR)); i++) m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}
