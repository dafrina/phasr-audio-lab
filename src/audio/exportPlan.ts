/**
 * Pure planning for WAV export: which tick range to render and how much
 * release/effect tail to add after it.
 */
import { ticksToSeconds } from '../core/time';
import { sendsTo, type Project, type Track } from '../project/types';
import { effectTailSeconds } from './effects/specs';

export type ExportRangeMode = 'song' | 'loop';

export class ExportRangeError extends Error {}

export interface ExportRange {
  startTick: number;
  endTick: number;
  seconds: number;
}

/** 'song' = bar 1 to the end of the last clip; 'loop' = the loop region. */
export function exportRange(p: Project, mode: ExportRangeMode): ExportRange {
  let startTick = 0;
  let endTick = 0;
  if (mode === 'loop') {
    startTick = p.loop.start;
    endTick = p.loop.end;
    if (endTick - startTick < 1) throw new ExportRangeError('The loop region is empty. Drag in the ruler to set one.');
  } else {
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const c of Object.values(p.clips)) if (ids.has(c.trackId)) endTick = Math.max(endTick, c.start + c.length);
    if (endTick <= 0) throw new ExportRangeError('There is nothing to export yet — add some clips first.');
  }
  return { startTick, endTick, seconds: ticksToSeconds(endTick - startTick, p.bpm) };
}

const MAX_TAIL = 30;

/** Ring-out time after the last note/clip: instrument release + chained effect tails (per track, worst case). */
export function estimateTailSeconds(p: Project, trackAudible: (t: Track) => boolean): number {
  let tail = 0;
  for (const t of p.tracks) {
    if (!trackAudible(t)) continue;
    let inst = 0;
    const cfg = t.instrument;
    if (cfg?.type === 'triosc') inst = cfg.patch.ampEnv.release;
    if (cfg?.type === 'keys') {
      // undamped treble strings / tine damper / rotary / amp release
      inst = cfg.engine === 'piano' ? 3 : cfg.engine === 'epiano' ? 0.8 : cfg.engine === 'organ' ? 0.3 : cfg.engine === 'sub808' ? Math.max(cfg.params.release ?? 0.25, cfg.params.decay ?? 1.8) : (cfg.params.release ?? 1);
    }
    if (cfg?.type === 'sampler') {
      // release tail, or (one-shot) the longest sample
      const longest = Math.max(0, ...cfg.zones.map((z) => p.assets[z.assetId]?.durationSec ?? 0));
      inst = cfg.params.oneShot ? longest : cfg.params.release * 1.2;
    }
    if (cfg?.type === 'drumrack') {
      for (const pad of cfg.kit.pads) {
        const rate = Math.pow(2, pad.tune / 12);
        const natural = pad.source.kind === 'synth' ? pad.source.length * 1.3 : (p.assets[pad.source.assetId]?.durationSec ?? 0) / rate;
        inst = Math.max(inst, Math.min(pad.decay, natural));
      }
    }
    const fx = t.effects.reduce((a, s) => a + effectTailSeconds(s, p.bpm), 0);
    tail = Math.max(tail, inst + fx);
  }
  // a send channel rings on after the tracks that feed it
  let sendTail = 0;
  (p.sends ?? []).forEach((bus, k) => {
    if (bus.mute || !p.tracks.some((t) => trackAudible(t) && sendsTo(t, k))) return;
    sendTail = Math.max(sendTail, bus.effects.reduce((a, s) => a + effectTailSeconds(s, p.bpm), 0));
  });
  tail += sendTail;
  // the master's own reverb / delay rings on after every track
  tail += (p.master.effects ?? []).reduce((a, s) => a + effectTailSeconds(s, p.bpm), 0);
  return Math.min(MAX_TAIL, tail + 0.25);
}

export function trackAudibleFn(p: Project): (t: Track) => boolean {
  const anySolo = p.tracks.some((t) => t.solo);
  return (t) => !t.mute && (!anySolo || t.solo);
}
