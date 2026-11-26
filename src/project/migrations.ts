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
const migrations: Record<number, Migration> = {};

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
  const trackIds = new Set(tracks.map((t) => t.id));
  const clips: Record<string, Clip> = {};
  if (isRec(raw.clips)) {
    for (const [id, c] of Object.entries(raw.clips)) {
      if (!isRec(c) || typeof c.trackId !== 'string' || !trackIds.has(c.trackId)) continue;
      if (c.kind !== 'midi' && c.kind !== 'audio') continue;
      clips[id] = { ...(c as unknown as Clip), id };
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
    timeSignature: { numerator: n(ts.numerator, 4, 1, 16), denominator: [2, 4, 8, 16].includes(ts.denominator as number) ? (ts.denominator as number) : 4 },
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
    loop: { enabled: loop.enabled === true, start: n(loop.start, 0, 0), end: n(loop.end, 15360, 1) },
    metronome: raw.metronome === true,
    countInBars: n(raw.countInBars, 1, 0, 4),
    assets: isRec(raw.assets) ? (raw.assets as Project['assets']) : {},
    createdAt: n(raw.createdAt, Date.now()),
    updatedAt: n(raw.updatedAt, Date.now()),
  };
  // modulation routes reference other tracks, so they are validated against the finished project
  sanitizeAllRoutes(project, rawTracks.map((t) => t?.modulations));
  return project;
}
