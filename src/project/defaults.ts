import { createId } from '../core/ids';
import { PPQ, barsToTicks } from '../core/time';
import { INSTRUMENTS } from '../instruments/definitions';
import {
  PROJECT_SCHEMA_VERSION,
  type AudioClip,
  type MidiClip,
  type Project,
  type Track,
  type InstrumentConfig,
  type TrackKind,
} from './types';

export const TRACK_COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#4ade80', '#f472b6', '#facc15', '#60a5fa', '#f87171'];

/** New track; instrument tracks default to TriOsc unless an instrument config is given. */
export function createTrack(kind: TrackKind, index: number, instrument?: InstrumentConfig): Track {
  const inst = kind === 'instrument' ? (instrument ?? INSTRUMENTS.triosc.createConfig()) : null;
  return {
    id: createId('trk'),
    name: inst ? `${INSTRUMENTS[inst.type].trackName} ${index + 1}` : `Audio ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length] ?? '#888888',
    kind,
    volumeDb: -6,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    monitor: false,
    instrument: inst,
    effects: [],
    automation: [],
    modulations: [],
  };
}

export function createProject(name = 'Untitled Project'): Project {
  const now = Date.now();
  const tracks = [createTrack('audio', 0), createTrack('instrument', 1)];
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId('prj'),
    name,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks,
    clips: {},
    master: { volumeDb: 0, limiter: true },
    loop: { enabled: false, start: 0, end: barsToTicks(4, { numerator: 4, denominator: 4 }) },
    metronome: false,
    countInBars: 1,
    assets: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function createMidiClip(trackId: string, start: number, length = PPQ * 4 * 4): MidiClip {
  return {
    id: createId('clp'),
    kind: 'midi',
    trackId,
    name: 'MIDI Clip',
    start,
    length,
    loopLength: length,
    loop: false,
    notes: [],
  };
}

export function createAudioClip(trackId: string, assetId: string, name: string, start: number, length: number): AudioClip {
  return {
    id: createId('clp'),
    kind: 'audio',
    trackId,
    name,
    start,
    length,
    assetId,
    sourceOffset: 0,
    gain: 1,
    loop: false,
    loopSeconds: 0,
    loopStartPhase: 0,
    fadeIn: 0.005,
    fadeOut: 0.005,
  };
}
