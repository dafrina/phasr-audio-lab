import { createId } from '../core/ids';
import { PPQ, barsToTicks } from '../core/time';
import { INSTRUMENTS } from '../instruments/definitions';
import { createEffectSlot } from '../audio/effects/specs';
import {
  PROJECT_SCHEMA_VERSION,
  SEND_IDS,
  type SendBus,
  type AudioClip,
  type MidiClip,
  type Project,
  type Track,
  type InstrumentConfig,
  type TrackKind,
} from './types';

export const TRACK_COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#4ade80', '#f472b6', '#facc15', '#60a5fa', '#f87171', '#2dd4bf', '#c084fc', '#a3e635', '#fb7185'];

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
    chords: null,
    arp: null,
    sends: [0, 0],
  };
}

/** Starting chains: A = a reverb, B = a delay, both fully wet (the dry sound stays on the tracks). Any effects can go there. */
export function defaultSendBuses(): SendBus[] {
  const reverb = createEffectSlot('reverb');
  if (reverb.type === 'reverb') reverb.params = { ...reverb.params, mix: 1, decay: 2.4 };
  const delay = createEffectSlot('delay');
  if (delay.type === 'delay') delay.params = { ...delay.params, mix: 1 };
  return [
    { id: SEND_IDS[0], name: 'Send A', volumeDb: 0, mute: false, effects: [reverb] },
    { id: SEND_IDS[1], name: 'Send B', volumeDb: 0, mute: false, effects: [delay] },
  ];
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
    master: { volumeDb: 0, limiter: true, effects: [] },
    sends: defaultSendBuses(),
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

/**
 * A new audio clip. `warpBpm`: the tempo the audio was played at — the clip then follows the project tempo
 * (warp on; recordings and imports pass the project's tempo). Without it the audio plays at its own speed.
 */
export function createAudioClip(trackId: string, assetId: string, name: string, start: number, length: number, warpBpm?: number): AudioClip {
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
    warp: warpBpm !== undefined,
    bpm: warpBpm ?? 120,
  };
}
