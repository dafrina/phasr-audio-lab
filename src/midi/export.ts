/**
 * Project / clip → Standard MIDI File. Exports what plays: looping clip
 * content is written out, Slipper-izer tracks as the chords you hear.
 * One MIDI track per instrument track (its name, its own channel; drum
 * racks on the General MIDI drum channel 10), plus the tempo and metre.
 */
import { PPQ } from '../core/time';
import { withChordsExpanded } from '../chords/expand';
import { expandMidiClipNotes } from '../project/clipOps';
import type { MidiClip, Project, Track } from '../project/types';
import { writeMidiFile } from './smf';

type OutNote = { pitch: number; start: number; length: number; velocity: number };

const DRUM_CHANNEL = 9;

/** Channels for melodic tracks: 1–16 without the drum channel. */
function channelFor(track: Track, melodicIndex: number): number {
  if (track.instrument?.type === 'drumrack') return DRUM_CHANNEL;
  const ch = melodicIndex % 15;
  return ch >= DRUM_CHANNEL ? ch + 1 : ch;
}

function clipNotes(clip: MidiClip, offset: number): OutNote[] {
  return expandMidiClipNotes(clip).map((n) => ({
    pitch: n.pitch,
    start: Math.max(0, Math.round(offset + n.start)),
    length: Math.max(1, Math.round(Math.min(n.length, clip.length - n.start))),
    velocity: Math.min(127, Math.max(1, Math.round(n.velocity))),
  }));
}

/** The whole song: every instrument track that has notes. Returns null if there are none. */
export function projectToMidi(project: Project): Uint8Array | null {
  const p = withChordsExpanded(project);
  const tracks: { name: string; channel: number; notes: OutNote[] }[] = [];
  let melodic = 0;
  for (const t of p.tracks) {
    if (t.kind !== 'instrument') continue;
    const notes = Object.values(p.clips)
      .filter((c): c is MidiClip => c.kind === 'midi' && c.trackId === t.id)
      .flatMap((c) => clipNotes(c, c.start));
    const channel = channelFor(t, melodic);
    if (t.instrument?.type !== 'drumrack') melodic++;
    if (notes.length) tracks.push({ name: t.name, channel, notes });
  }
  if (!tracks.length) return null;
  return writeMidiFile({ ppq: PPQ, bpm: p.bpm, timeSignature: p.timeSignature, tracks });
}

/** One clip, starting at 0. Returns null if the clip has no notes. */
export function clipToMidi(project: Project, clipId: string): Uint8Array | null {
  const p = withChordsExpanded(project);
  const clip = p.clips[clipId];
  if (!clip || clip.kind !== 'midi') return null;
  const notes = clipNotes(clip, 0);
  if (!notes.length) return null;
  const track = p.tracks.find((t) => t.id === clip.trackId);
  return writeMidiFile({
    ppq: PPQ,
    bpm: p.bpm,
    timeSignature: p.timeSignature,
    tracks: [{ name: clip.name, channel: track ? channelFor(track, 0) : 0, notes }],
  });
}
