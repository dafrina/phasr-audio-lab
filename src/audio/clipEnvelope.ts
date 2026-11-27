/**
 * Gain envelope of one audio-clip playback, as absolute-time breakpoints
 * (linear in between). The clip's fades belong to the whole clip (clip time
 * 0 … its duration). Playback can start inside the clip (play or seek from
 * mid-clip, and every reschedule while playing — an edit, a tempo change)
 * and stop before its end (the loop region's end, a song boundary): only
 * there is a short de-click ramp added. Pure, so it can be tested in Node.
 */

export interface EnvPoint {
  t: number;
  v: number;
}

export interface ClipPlayback {
  /** context time playback starts / stops */
  when: number;
  stopAt: number;
  /** clip time at `when` (0 = the clip's start) */
  clipOffset: number;
  /** the whole clip's length in seconds */
  clipDuration: number;
  fadeIn: number;
  fadeOut: number;
  gain: number;
}

/** ramp length at a cut (a start or stop inside the clip) */
export const DECLICK = 0.004;
/** the clip's own fades are at least this long (no click at its very start / end) */
const MIN_FADE = 0.002;

export function clipEnvelope(p: ClipPlayback): EnvPoint[] {
  const { when, stopAt, gain } = p;
  if (!(stopAt > when)) return [];
  const c0 = Math.max(0, p.clipOffset);
  const c1 = c0 + (stopAt - when);
  const dur = Math.max(p.clipDuration, c1);
  const fi = Math.max(MIN_FADE, p.fadeIn);
  const fo = Math.max(MIN_FADE, p.fadeOut);
  /** the clip's level at clip time c (overlapping fades meet where their lines cross) */
  const level = (c: number) => gain * Math.max(0, Math.min(1, c / fi, (dur - c) / fo));
  const toT = (c: number) => when + (c - c0);

  // de-click ramps where playback cuts into the clip
  const d = Math.min(DECLICK, (stopAt - when) / 2);
  const cutIn = c0 > 1e-6 && level(c0) > 0;
  const cutOut = c1 < dur - 1e-6 && level(c1) > 0;
  const from = cutIn ? c0 + d : c0;
  const to = cutOut ? c1 - d : c1;

  // the envelope's corners inside the played part
  const corners = [from, to, fi, dur - fo, (dur * fi) / (fi + fo)].filter((c) => c >= from && c <= to);
  const cs = [...new Set(corners)].sort((a, b) => a - b);
  const out: EnvPoint[] = [];
  if (cutIn) out.push({ t: when, v: 0 });
  for (const c of cs) out.push({ t: toT(c), v: level(c) });
  if (cutOut) out.push({ t: stopAt, v: 0 });
  return out;
}

/** The envelope's value at time t (0 before it starts and after it ends). */
export function envelopeAt(env: readonly EnvPoint[], t: number): number {
  const first = env[0];
  const last = env[env.length - 1];
  if (!first || !last || t < first.t || t > last.t) return 0;
  for (let i = 1; i < env.length; i++) {
    const a = env[i - 1] as EnvPoint;
    const b = env[i] as EnvPoint;
    if (t <= b.t) return b.t > a.t ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : b.v;
  }
  return last.v;
}
