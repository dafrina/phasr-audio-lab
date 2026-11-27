/**
 * Which buffer a planned audio clip plays from, where in it and how fast —
 * one function for playback and export, so both play the same samples.
 * A warped clip plays its stretched copy (stretch/cache.ts) at rate 1; until
 * that is rendered (live only — export waits for it), the nearest cached copy
 * or the original at a rate that keeps the timing right.
 */
import type { PlannedAudio } from './scheduling';
import type { StretchCache } from './stretch/cache';
import { stretchFactorFor, warpRate } from './warp';
import type { Clip } from '../project/types';

export interface WarpedPlayback {
  buffer: AudioBuffer;
  /** seconds into `buffer` */
  sourcePos: number;
  loop: { start: number; end: number } | null;
  /** the buffer source's playbackRate */
  rate: number;
  /** the stretched copy for this tempo (or no warp needed) */
  exact: boolean;
}

export function warpedPlayback(a: Pick<PlannedAudio, 'clip' | 'sourcePos' | 'rate'>, original: AudioBuffer, cache: StretchCache): WarpedPlayback {
  const clip = a.clip;
  const loop = clip.loop && clip.loopSeconds > 0 ? { start: clip.sourceOffset, end: clip.sourceOffset + clip.loopSeconds } : null;
  if (a.rate === 1) return { buffer: original, sourcePos: a.sourcePos, loop, rate: 1, exact: true };
  const factor = stretchFactorFor(a.rate);
  const exact = cache.get(clip.assetId, factor);
  const pick = exact ? { buffer: exact, factor } : (cache.nearest(clip.assetId, factor) ?? { buffer: original, factor: 1 });
  const f = pick.factor;
  return {
    buffer: pick.buffer,
    sourcePos: a.sourcePos * f,
    loop: loop && { start: loop.start * f, end: loop.end * f },
    rate: exact ? 1 : a.rate * f,
    exact: !!exact,
  };
}

/** the stretched copies a project's warped audio clips need (assetId + factor) */
export function stretchNeeds(clips: Iterable<Clip>, bpm: number): { assetId: string; factor: number }[] {
  const out = new Map<string, { assetId: string; factor: number }>();
  for (const c of clips) {
    if (c.kind !== 'audio') continue;
    const rate = warpRate(c, bpm);
    if (rate === 1) continue;
    const factor = stretchFactorFor(rate);
    out.set(`${c.assetId}|${factor}`, { assetId: c.assetId, factor });
  }
  return [...out.values()];
}
