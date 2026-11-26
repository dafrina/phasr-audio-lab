/**
 * Applying the Arp / Step sequencer to project data, after the Gucci
 * Slipper-izer (so a held key → chord → arpeggio). Clips keep the keys you
 * held; playback, export and MIDI export read them through here, and "Bake to
 * notes" writes the result into the clips.
 */
import { PPQ } from '../core/time';
import { withChordsExpanded, chordToolActive } from '../chords/expand';
import { expandMidiClipNotes } from '../project/clipOps';
import type { Clip, MidiClip, Project, Track } from '../project/types';
import { expandHeld, type ArpConfig } from './arp';

export function arpActive(track: Track | undefined): track is Track & { arp: ArpConfig } {
  return !!track && track.kind === 'instrument' && !!track.arp?.enabled;
}

const clipCache = new WeakMap<MidiClip, { cfg: ArpConfig; out: MidiClip }>();

/** One clip through the tool: its (loop-expanded) held notes → the pattern, clip-relative. */
export function arpClip(clip: MidiClip, cfg: ArpConfig): MidiClip {
  const hit = clipCache.get(clip);
  if (hit && hit.cfg === cfg) return hit.out;
  // steps sit on the song grid: work in absolute ticks
  const held = expandMidiClipNotes(clip).map((n) => ({ pitch: n.pitch, start: clip.start + n.start, length: n.length, velocity: n.velocity }));
  const notes = expandHeld(cfg, held, clip.start, clip.start + clip.length, PPQ).map((e, i) => ({
    id: `${clip.id}~a${i}`,
    pitch: e.pitch,
    start: e.start - clip.start,
    length: e.length,
    velocity: e.velocity,
  }));
  const out: MidiClip = { ...clip, notes, loop: false, loopLength: clip.length };
  clipCache.set(clip, { cfg, out });
  return out;
}

const projectCache = new WeakMap<Project, Project>();

/** The project as playback hears it: chords first, then the arp. Cheap when nothing changed. */
export function withToolsExpanded(source: Project): Project {
  const hit = projectCache.get(source);
  if (hit) return hit;
  const p = withChordsExpanded(source);
  const active = new Map<string, ArpConfig>();
  for (const t of p.tracks) if (arpActive(t)) active.set(t.id, t.arp);
  if (!active.size) {
    projectCache.set(source, p);
    return p;
  }
  const clips: Record<string, Clip> = {};
  for (const [id, c] of Object.entries(p.clips)) {
    const cfg = c.kind === 'midi' ? active.get(c.trackId) : undefined;
    clips[id] = cfg && c.kind === 'midi' ? arpClip(c, cfg) : c;
  }
  const out = { ...p, clips };
  projectCache.set(source, out);
  return out;
}

/**
 * Write what the track plays (chords and arp) into its clips as real notes and
 * switch both tools off.
 */
export function bakeArp(source: Project, trackId: string): Project {
  const track = source.tracks.find((t) => t.id === trackId);
  if (!arpActive(track)) return source;
  const heard = withToolsExpanded(source);
  const clips = { ...source.clips };
  for (const [id, c] of Object.entries(source.clips)) {
    if (c.kind !== 'midi' || c.trackId !== trackId) continue;
    const e = heard.clips[id];
    if (e && e.kind === 'midi') clips[id] = { ...c, notes: e.notes.map((n, i) => ({ ...n, id: `${c.id}-b${i}` })), loop: false, loopLength: c.length };
  }
  const chordsOff = chordToolActive(track) && track.chords ? { ...track.chords, enabled: false } : track.chords;
  return {
    ...source,
    clips,
    tracks: source.tracks.map((t) => (t.id === trackId ? { ...t, arp: { ...(t.arp as ArpConfig), enabled: false }, chords: chordsOff } : t)),
  };
}
