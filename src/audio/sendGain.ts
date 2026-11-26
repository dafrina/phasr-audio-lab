/** Send knob 0..1 → gain (squared: fine control at low levels; 1 = unity). */
export function sendGain(level: number): number {
  const v = Math.max(0, Math.min(1, level));
  return v * v;
}
