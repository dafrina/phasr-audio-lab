/**
 * Warp (pure): an audio clip with warp on follows the project tempo. Its
 * audio was played at `clip.bpm`; at the project tempo it plays
 * projectBpm / clip.bpm times as fast — time-stretched, so the pitch stays
 * (stretch/vocoder.ts). The rate is limited to 0.25×–4× (beyond that the
 * clip no longer fills its bars exactly); towards the extremes the stretch
 * is audibly rougher. Without warp the audio plays at its own speed (rate 1).
 *
 * Source positions (sourceOffset, loopSeconds, loopStartPhase) are in seconds
 * of the source audio; clip positions (length, fades) are timeline time.
 */
import type { AudioClip } from '../project/types';

export const WARP_MIN = 0.25;
export const WARP_MAX = 4;
/** below / above these rates the UI marks the stretch as lower quality */
export const WARP_GOOD_MIN = 0.5;
export const WARP_GOOD_MAX = 2;

/** source seconds played per timeline second */
export function warpRate(clip: Pick<AudioClip, 'warp' | 'bpm'>, projectBpm: number): number {
  if (!clip.warp || !(clip.bpm > 0)) return 1;
  return Math.min(WARP_MAX, Math.max(WARP_MIN, projectBpm / clip.bpm));
}

/** the stretch a warped clip needs: output length / input length (1 / rate), rounded so caches match */
export function stretchFactorFor(rate: number): number {
  return Math.round((1 / rate) * 1e4) / 1e4;
}

/** source seconds for a span of timeline seconds */
export function toSourceSeconds(clip: Pick<AudioClip, 'warp' | 'bpm'>, timelineSec: number, projectBpm: number): number {
  return timelineSec * warpRate(clip, projectBpm);
}

/** timeline seconds for a span of source seconds */
export function toTimelineSeconds(clip: Pick<AudioClip, 'warp' | 'bpm'>, sourceSec: number, projectBpm: number): number {
  return sourceSec / warpRate(clip, projectBpm);
}
