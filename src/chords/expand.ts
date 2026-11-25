/**
 * Applying the Gucci Slipper-izer to project data: clips on a track with the
 * chord tool keep the single notes you played; playback, export and the
 * piano roll's chord labels read them through here. "Bake to notes" writes
 * the expanded chords into the clips for good.
 */
import { PPQ, ticksPerBar } from '../core/time';
import type { Clip, MidiClip, Project, Track } from '../project/types';
import { expandNote, type ChordToolConfig } from './theory';

/** Whether a track's chord tool is switched on (instrument tracks except drum racks). */
export function chordToolActive(track: Track | undefined): track is Track & { chords: ChordToolConfig } {
  return !!track && track.kind === 'instrument' && !!track.chords?.enabled && track.instrument?.type !== 'drumrack';
}

/** Whether a track can host the chord tool at all. */
export function chordToolAvailable(track: Track | undefined): boolean {
  return !!track && track.kind === 'instrument' && track.instrument?.type !== 'drumrack';
}

const clipCache = new WeakMap<MidiClip, { cfg: ChordToolConfig; bar: number; out: MidiClip }>();

export function expandClip(clip: MidiClip, cfg: ChordToolConfig, barTicks: number): MidiClip {
  const hit = clipCache.get(clip);
  if (hit && hit.cfg === cfg && hit.bar === barTicks) return hit.out;
  const notes = clip.notes.flatMap((n) =>
    expandNote(cfg, n, barTicks, PPQ, clip.start).map((e, i) => ({ id: `${n.id}~${i}`, pitch: e.pitch, start: e.start, length: e.length, velocity: e.velocity })),
  );
  const out: MidiClip = { ...clip, notes };
  clipCache.set(clip, { cfg, bar: barTicks, out });
  return out;
}

const projectCache = new WeakMap<Project, Project>();

/** The project as the scheduler should hear it (chord-tool tracks expanded). Cheap when nothing changed. */
export function withChordsExpanded(p: Project): Project {
  const hit = projectCache.get(p);
  if (hit) return hit;
  const active = new Map<string, ChordToolConfig>();
  for (const t of p.tracks) if (chordToolActive(t)) active.set(t.id, t.chords);
  if (!active.size) {
    projectCache.set(p, p);
    return p;
  }
  const bar = ticksPerBar(p.timeSignature);
  const clips: Record<string, Clip> = {};
  for (const [id, c] of Object.entries(p.clips)) {
    const cfg = c.kind === 'midi' ? active.get(c.trackId) : undefined;
    clips[id] = cfg && c.kind === 'midi' ? expandClip(c, cfg, bar) : c;
  }
  const out = { ...p, clips };
  projectCache.set(p, out);
  return out;
}

/** Write the chords into every MIDI clip of the track and switch the chord tool off. */
export function bakeChords(p: Project, trackId: string): Project {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!chordToolActive(track)) return p;
  const bar = ticksPerBar(p.timeSignature);
  const clips: Record<string, Clip> = {};
  for (const [id, c] of Object.entries(p.clips)) {
    if (c.trackId !== trackId || c.kind !== 'midi') {
      clips[id] = c;
      continue;
    }
    const e = expandClip(c, track.chords, bar);
    clips[id] = { ...c, notes: e.notes.map((n, i) => ({ ...n, id: `${c.id}_b${i}` })) };
  }
  return { ...p, clips, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, chords: { ...track.chords, enabled: false } } : t)) };
}
