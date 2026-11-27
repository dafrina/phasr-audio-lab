/**
 * Project schema migrations. Each entry upgrades a raw project object from
 * version N to N+1. `migrateProject` applies them in order and then validates
 * the result so older or hand-edited files can't put the app in a bad state.
 */
import { sanitizeInstrument } from '../instruments/definitions';
import { sanitizeEffect } from '../audio/effects/specs';
import { sanitizeLanes } from './automation';
import { sanitizeAllRoutes } from './modulation';
import { createId } from '../core/ids';
import { MAX_EFFECT_SLOTS, MAX_TRACKS, PROJECT_SCHEMA_VERSION, SEND_COUNT, SEND_IDS, type Clip, type Project, type SendBus, type Track } from './types';
import { TRACK_COLORS, defaultSendBuses } from './defaults';
import { sanitizeChordTool } from '../chords/theory';
import { sanitizeArp } from '../arp/arp';

type RawProject = Record<string, unknown>;
type Migration = (p: RawProject) => RawProject;

/** migrations[n] upgrades version n → n+1. Version 1 is the first release. */
const migrations: Record<number, Migration> = {
  1: drumPadsToGeneralMidi,
  2: audioClipsWarpOff,
};

/**
 * v2 → v3: audio clips can follow the tempo (warp). Clips made before keep
 * today's behaviour — warp off, the audio at its own speed — with the
 * project's tempo as their tempo (switching warp on later changes nothing
 * until the tempo does).
 */
function audioClipsWarpOff(raw: RawProject): RawProject {
  if (!isRec(raw.clips)) return raw;
  const bpm = typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) ? raw.bpm : 120;
  const clips: Record<string, unknown> = {};
  for (const [id, c] of Object.entries(raw.clips)) clips[id] = isRec(c) && c.kind === 'audio' ? { ...c, warp: false, bpm } : c;
  return { ...raw, clips };
}

/**
 * v1 → v2: the Drum Rack's pads moved to the General MIDI layout (closed hat
 * 41 → 42, open hat 43 → 46, crash 45 → 49 …; drums/kit.ts). V1_PAD_SLOT[i] is
 * where v1 pad i is now. Every drum track's pads move there, and so does
 * everything that names a pad — its notes, its automation lanes
 * (p<i>.<field>) and the note of sidechain routes that listen to the track —
 * so a project sounds exactly as before. (A v1 kit
 * saved with pads missing got the v1 default pads; the default kit holds the
 * same pads at their new places, so holes move along too.) Notes an
 * arpeggiator on a drum track transposes onto other pads can't be kept.
 */
const V1_PAD_SLOT = [0, 1, 2, 3, 5, 6, 9, 10, 12, 13, 8, 15, 7, 4, 11, 14];

function drumPadsToGeneralMidi(raw: RawProject): RawProject {
  const tracks = Array.isArray(raw.tracks) ? raw.tracks.map((t) => (isRec(t) ? { ...t } : t)) : raw.tracks;
  if (!Array.isArray(tracks)) return raw;
  const note = (v: unknown) => (typeof v === 'number' && Math.round(v) >= 36 && Math.round(v) <= 51 ? 36 + (V1_PAD_SLOT[Math.round(v) - 36] as number) : v);
  const key = (v: unknown) => (typeof v === 'string' ? v.replace(/^p(\d+)\./, (m, i: string) => (+i < 16 ? `p${V1_PAD_SLOT[+i]}.` : m)) : v);
  const padLane = (o: unknown) => (isRec(o) && isRec(o.target) && o.target.kind === 'inst' ? { ...o, target: { ...o.target, param: key(o.target.param) } } : o);
  const drums = new Set<unknown>();
  for (const t of tracks) {
    if (!isRec(t) || !isRec(t.instrument) || t.instrument.type !== 'drumrack') continue;
    drums.add(t.id);
    const kit = t.instrument.kit;
    if (isRec(kit) && Array.isArray(kit.pads)) {
      const pads: unknown[] = new Array(16).fill(undefined);
      kit.pads.slice(0, 16).forEach((p, i) => (pads[V1_PAD_SLOT[i] as number] = p));
      t.instrument = { ...t.instrument, kit: { ...kit, pads } };
    }
    if (Array.isArray(t.automation)) t.automation = t.automation.map(padLane);
  }
  // sidechains listening to one pad of a drum track
  for (const t of tracks) {
    if (isRec(t) && Array.isArray(t.modulations))
      t.modulations = t.modulations.map((r) => (isRec(r) && drums.has(r.sourceTrackId) && r.note !== null ? { ...r, note: note(r.note) } : r));
  }
  const clips = isRec(raw.clips) ? { ...raw.clips } : raw.clips;
  if (isRec(clips)) {
    for (const [id, c] of Object.entries(clips)) {
      if (isRec(c) && drums.has(c.trackId) && Array.isArray(c.notes))
        clips[id] = { ...c, notes: c.notes.map((n) => (isRec(n) ? { ...n, pitch: note(n.pitch) } : n)) };
    }
  }
  return { ...raw, tracks, clips };
}

export class ProjectFormatError extends Error {}

export function migrateProject(input: unknown): Project {
  if (input === null || typeof input !== 'object') throw new ProjectFormatError('Project file is not a JSON object.');
  let raw = { ...(input as RawProject) };
  let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project was saved by a newer version (schema ${version}); this app supports up to ${PROJECT_SCHEMA_VERSION}.`,
    );
  }
  if (version < 1) version = 1; // pre-versioned data is treated as v1
  while (version < PROJECT_SCHEMA_VERSION) {
    const m = migrations[version];
    if (!m) throw new ProjectFormatError(`No migration from schema ${version}.`);
    raw = m(raw);
    version += 1;
  }
  return validateProject({ ...raw, schemaVersion: PROJECT_SCHEMA_VERSION });
}

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function n(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, x));
}

const MIN_CLIP = 60;
const int = (v: unknown, fallback: number, min = -Infinity, max = Infinity) => Math.round(n(v, fallback, min, max));

/**
 * A clip as stored, checked: numbers finite and in range (positions are kept as they are — they
 * may be fractional ticks, e.g. audio lengths from seconds), notes
 * well-formed, MIDI only on instrument tracks and audio only on audio tracks. Unusable clips
 * (no track, wrong kind, no asset id) are dropped.
 */
function sanitizeClip(c: Record<string, unknown>, id: string, kindOf: Map<string, Track['kind']>, projectBpm: number): Clip | null {
  const trackKind = typeof c.trackId === 'string' ? kindOf.get(c.trackId) : undefined;
  if (!trackKind) return null;
  const base = {
    id,
    trackId: c.trackId as string,
    name: typeof c.name === 'string' ? c.name.slice(0, 64) : 'Clip',
    start: n(c.start, 0, 0),
    length: n(c.length, MIN_CLIP, MIN_CLIP),
  };
  if (c.kind === 'midi' && trackKind === 'instrument') {
    const notes = (Array.isArray(c.notes) ? c.notes : []).filter(isRec).flatMap((x) => {
      if (typeof x.pitch !== 'number' || typeof x.start !== 'number' || typeof x.length !== 'number') return [];
      if (![x.pitch, x.start, x.length].every(Number.isFinite)) return [];
      return [{ id: typeof x.id === 'string' ? x.id : createId('n'), pitch: int(x.pitch, 60, 0, 127), start: n(x.start, 0, 0), length: n(x.length, 1, 1), velocity: int(x.velocity, 100, 1, 127) }];
    });
    return { ...base, kind: 'midi', notes, loop: c.loop === true, loopLength: n(c.loopLength, base.length, 1) };
  }
  if (c.kind === 'audio' && trackKind === 'audio' && typeof c.assetId === 'string') {
    const loopSeconds = n(c.loopSeconds, 0, 0);
    return {
      ...base,
      kind: 'audio',
      assetId: c.assetId,
      sourceOffset: n(c.sourceOffset, 0, 0),
      gain: n(c.gain, 1, 0, 2),
      loop: c.loop === true && loopSeconds > 0,
      loopSeconds,
      loopStartPhase: loopSeconds > 0 ? n(c.loopStartPhase, 0, 0) % loopSeconds : 0,
      fadeIn: n(c.fadeIn, 0, 0),
      fadeOut: n(c.fadeOut, 0, 0),
      warp: c.warp === true,
      bpm: n(c.bpm, projectBpm, 5, 1200),
    };
  }
  return null;
}

/** Asset references: well-formed entries only (the bytes live in storage under the same id). */
function sanitizeAssets(raw: unknown): Project['assets'] {
  const out: Project['assets'] = {};
  if (!isRec(raw)) return out;
  for (const [id, a] of Object.entries(raw)) {
    if (!isRec(a) || typeof a.name !== 'string') continue;
    out[id] = { id, name: a.name, sampleRate: n(a.sampleRate, 48000, 1), channels: int(a.channels, 2, 1, 32), durationSec: n(a.durationSec, 0, 0), frames: int(a.frames, 0, 0) };
  }
  return out;
}

/** The loop region, start before end (swapped if stored the wrong way round). */
function sanitizeLoop(loop: Record<string, unknown>): Project['loop'] {
  const a = n(loop.start, 0, 0);
  const b = n(loop.end, 15360, 0);
  const [start, end] = a < b ? [a, b] : a > b ? [b, a] : [a, a + 15360];
  return { enabled: loop.enabled === true, start, end };
}

/** Both send channels, always; missing ones (older projects) get the defaults (Reverb / Delay). */
function sanitizeSendBuses(raw: unknown): SendBus[] {
  const list = Array.isArray(raw) ? raw.filter(isRec) : [];
  const defs = defaultSendBuses();
  return SEND_IDS.map((id, k) => {
    const r = list.find((b) => b.id === id);
    const d = defs[k] as SendBus;
    if (!r) return d;
    return {
      id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 24) : d.name,
      volumeDb: n(r.volumeDb, 0, -60, 6),
      mute: r.mute === true,
      effects: (Array.isArray(r.effects) ? r.effects : [])
        .map(sanitizeEffect)
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .slice(0, MAX_EFFECT_SLOTS),
    };
  });
}

function validateProject(raw: RawProject): Project {
  if (!Array.isArray(raw.tracks)) throw new ProjectFormatError('Project has no track list.');
  const tracks: Track[] = raw.tracks.slice(0, MAX_TRACKS).filter(isRec).map((t, i) => {
    const kind = t.kind === 'audio' ? 'audio' : 'instrument';
    const inst = isRec(t.instrument) ? t.instrument : null;
    return {
      id: typeof t.id === 'string' ? t.id : createId('trk'),
      name: typeof t.name === 'string' ? t.name : `Track ${i + 1}`,
      color: typeof t.color === 'string' ? t.color : (TRACK_COLORS[i] ?? '#888'),
      kind,
      volumeDb: n(t.volumeDb, -6, -60, 6),
      pan: n(t.pan, 0, -1, 1),
      mute: t.mute === true,
      solo: t.solo === true,
      armed: t.armed === true,
      monitor: t.monitor === true,
      // any registered instrument type; unknown types fall back to TriOsc
      instrument: kind === 'instrument' ? sanitizeInstrument(inst) : null,
      effects: (Array.isArray(t.effects) ? t.effects : [])
        .map(sanitizeEffect)
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .slice(0, MAX_EFFECT_SLOTS),
      automation: [],
      modulations: [],
      chords: kind === 'instrument' ? sanitizeChordTool(t.chords) : null,
      arp: kind === 'instrument' ? sanitizeArp(t.arp) : null,
      sends: Array.from({ length: SEND_COUNT }, (_, k) => n(Array.isArray(t.sends) ? t.sends[k] : 0, 0, 0, 1)),
    } satisfies Track;
  });
  // automation lanes are validated against the (already sanitized) track they belong to
  const rawTracks = (raw.tracks as unknown[]).slice(0, MAX_TRACKS).filter(isRec);
  tracks.forEach((t, i) => {
    t.automation = sanitizeLanes(rawTracks[i]?.automation, t);
  });
  const kindOf = new Map(tracks.map((t) => [t.id, t.kind]));
  const clips: Record<string, Clip> = {};
  if (isRec(raw.clips)) {
    for (const [id, c] of Object.entries(raw.clips)) {
      const clip = isRec(c) ? sanitizeClip(c, id, kindOf, n(raw.bpm, 120, 20, 400)) : null;
      if (clip) clips[id] = clip;
    }
  }
  const ts = isRec(raw.timeSignature) ? raw.timeSignature : {};
  const loop = isRec(raw.loop) ? raw.loop : {};
  const master = isRec(raw.master) ? raw.master : {};
  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: typeof raw.id === 'string' ? raw.id : createId('prj'),
    name: typeof raw.name === 'string' ? raw.name : 'Untitled Project',
    bpm: n(raw.bpm, 120, 20, 400),
    timeSignature: { numerator: Math.round(n(ts.numerator, 4, 1, 16)), denominator: [2, 4, 8, 16].includes(ts.denominator as number) ? (ts.denominator as number) : 4 },
    tracks,
    clips,
    master: {
      volumeDb: n(master.volumeDb, 0, -60, 6),
      limiter: master.limiter !== false,
      effects: (Array.isArray(master.effects) ? master.effects : [])
        .map(sanitizeEffect)
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .slice(0, MAX_EFFECT_SLOTS),
    },
    sends: sanitizeSendBuses(raw.sends),
    loop: sanitizeLoop(loop),
    metronome: raw.metronome === true,
    countInBars: n(raw.countInBars, 1, 0, 4),
    assets: sanitizeAssets(raw.assets),
    createdAt: n(raw.createdAt, Date.now()),
    updatedAt: n(raw.updatedAt, Date.now()),
  };
  // modulation routes reference other tracks, so they are validated against the finished project
  sanitizeAllRoutes(project, rawTracks.map((t) => t?.modulations));
  return project;
}
