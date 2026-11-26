/**
 * The notes an Arp-Ape-ator track plays, as they are about to sound — for
 * visuals (the window lights the step / key, the gorilla hits). Two sources:
 * the live arp (keys held; it reports each note as it schedules it) and, while
 * the song plays, the track's clips as playback hears them (chords then arp),
 * read a little ahead of the playhead so a hit can be timed to land on its note.
 */
import { useEffect, useRef } from 'react';
import { engine } from '../../audio/engine';
import { withToolsExpanded } from '../../arp/expand';
import { PPQ } from '../../core/time';
import { getProject } from '../../state/projectStore';

export interface ArpBeat {
  pitch: number;
  /** 1..127 */
  velocity: number;
  /** step index on the song grid (or from the free clock's start); wrap it by the pattern length */
  step: number;
  /** ms from now until the note sounds */
  landMs: number;
}

/** how far ahead of the playhead clip notes are read */
const AHEAD = 0.16;
const CHECK_MS = 15;

export function useArpBeats(trackId: string, onBeat: (b: ArpBeat) => void): void {
  const cb = useRef(onBeat);
  cb.current = onBeat;

  useEffect(() => {
    const off = engine.onArpNote((tid, pitch, velocity, at, step) => {
      if (tid !== trackId) return;
      const ctx = engine.ctx;
      cb.current({ pitch, velocity, step, landMs: ctx ? Math.max(0, (at - ctx.currentTime) * 1000) : 0 });
    });

    /** clip notes up to this tick have been reported (-1: start over) */
    let scanned = -1;
    const timer = setInterval(() => {
      const t = engine.transport;
      const ctx = engine.ctx;
      if (!t || !ctx || !t.isPlaying() || t.isCountingIn()) {
        scanned = -1;
        return;
      }
      const src = getProject();
      const tps = (src.bpm * PPQ) / 60;
      // the tick that sounds AHEAD seconds from now
      const horizon = t.tickAtContextTime(ctx.currentTime + AHEAD);
      if (scanned < 0 || horizon < scanned || horizon - scanned > tps * 2) {
        // started, looped or jumped: pick up from just before the playhead
        scanned = horizon - tps * (AHEAD + 0.03);
      }
      if (horizon <= scanned) return;
      const p = withToolsExpanded(src);
      const cfg = p.tracks.find((x) => x.id === trackId)?.arp;
      const st = Math.max(1, Math.round((cfg?.rate ?? 0.25) * PPQ));
      let n = 0;
      for (const c of Object.values(p.clips)) {
        if (c.kind !== 'midi' || c.trackId !== trackId) continue;
        for (const note of c.notes) {
          const s = c.start + note.start;
          if (s <= scanned || s > horizon || n++ >= 8) continue;
          cb.current({ pitch: note.pitch, velocity: note.velocity, step: Math.floor(s / st), landMs: Math.max(0, (AHEAD - (horizon - s) / tps) * 1000) });
        }
      }
      scanned = horizon;
    }, CHECK_MS);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [trackId]);
}
