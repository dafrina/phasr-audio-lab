/**
 * Algorithmic reverb impulse response: decorrelated stereo noise with an
 * exponential decay reaching -60 dB at `decay` seconds, sparse early
 * reflections, and progressive high-frequency damping (later parts of the
 * tail get darker, like a real room). A seeded PRNG makes the IR — and
 * therefore realtime playback and offline export — fully deterministic.
 *
 * Shape (all 1 / 0.5 by default, which gives exactly the original IR):
 *  - size: scales the early reflections' arrival times (bigger room → later, sparser)
 *  - damping: 0 bright … 1 dark: how strongly the tail's highs are absorbed
 *  - early: the early reflections, 0 = none … 1 = as they were … 2 = up front: louder, with
 *    the dense tail building up after them (as in a real room) so the first echoes stand out
 */
export interface ImpulseShape {
  size?: number;
  damping?: number;
  early?: number;
}

export function generateImpulse(sampleRate: number, decay: number, shape: ImpulseShape = {}, seed = 0x9e3779b9): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const size = shape.size ?? 1;
  const damping = shape.damping ?? 0.5;
  // (exactly 1 at the default, so the default IR is bit-identical to the original)
  const dampScale = damping === 0.5 ? 1 : 0.3 + 1.4 * damping;
  const early = shape.early ?? 1;
  // with early > 1 the diffuse tail swells in over up to ~60 ms (× size) behind the reflections
  const build = early > 1 ? Math.round((early - 1) * 0.06 * size * sampleRate) : 0;
  // reflection level: as before at 1, fading out below, up to 4× (squared) above
  const erGain = early <= 1 ? early : early * early;
  // the tail ends at its -60 dB point; anything later is inaudible and only costs convolution time
  const length = Math.max(1, Math.round((decay + 0.05) * sampleRate));
  const out: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(length), new Float32Array(length)];
  const k = Math.log(1000) / (decay * sampleRate); // amplitude e^(-k n) → -60 dB at decay
  for (let ch = 0; ch < 2; ch++) {
    let state = (seed ^ (ch * 0x85ebca6b)) | 0 || 1;
    const rand = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state | 0) / 2147483648;
    };
    const buf = out[ch] as Float32Array;
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // damping: one-pole low-pass whose cutoff falls over the tail
      const coef = Math.min(0.97, (0.15 + 0.8 * t) * dampScale);
      lp += (rand() - lp) * (1 - coef);
      const env = Math.exp(-k * i);
      buf[i] = lp * env * (build > 0 && i < build ? i / build : 1);
    }
    // early reflections in the first ~80 ms
    for (let r = 0; r < 10; r++) {
      const at = Math.floor((0.004 + Math.abs(rand()) * 0.075) * size * sampleRate);
      if (at < length) buf[at] = (buf[at] as number) + rand() * 0.6 * erGain * Math.exp(-k * at);
    }
    // 2 ms fade-in to avoid a click at the very start
    const fade = Math.min(length, Math.round(0.002 * sampleRate));
    for (let i = 0; i < fade; i++) buf[i] = (buf[i] as number) * (i / fade);
  }
  return out;
}
