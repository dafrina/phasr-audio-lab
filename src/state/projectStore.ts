/**
 * Project store. All project mutations go through `commit`, which records an
 * undo step (optionally coalesced). Components never mutate project objects.
 */
import { create } from 'zustand';
import { createProject } from '../project/defaults';
import type { Clip, InstrumentConfig, Project, Track } from '../project/types';
import { createHistory, pushHistory, redoHistory, replacePresent, undoHistory, type History } from './history';
import type { TriOscPatch } from '../synth/params';

export interface CommitOptions {
  /** Merge consecutive commits with the same key into one undo step */
  coalesce?: string;
  /** Do not create an undo step at all */
  skipHistory?: boolean;
}

interface ProjectStore {
  history: History<Project>;
  project: Project;
  commit: (label: string, recipe: (p: Project) => Project, opts?: CommitOptions) => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project) => void;
}

/**
 * Arm and monitor aren't part of undo (they're committed without history):
 * an undo / redo keeps them as they are now — restoring an old snapshot would
 * otherwise disarm the track and close its input. A track the undo brings back
 * comes back unarmed (only one track can be armed).
 */
function keepUnundoable(next: Project, now: Project): Project {
  const cur = new Map(now.tracks.map((t) => [t.id, t]));
  let changed = false;
  const tracks = next.tracks.map((t) => {
    const c = cur.get(t.id);
    const armed = c ? c.armed : false;
    const monitor = c ? c.monitor : t.monitor;
    if (t.armed === armed && t.monitor === monitor) return t;
    changed = true;
    return { ...t, armed, monitor };
  });
  return changed ? { ...next, tracks } : next;
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  const initial = createProject();
  return {
    history: createHistory(initial),
    project: initial,
    commit: (label, recipe, opts = {}) => {
      const { history } = get();
      const nextRaw = recipe(history.present);
      if (nextRaw === history.present) return;
      const next = { ...nextRaw, updatedAt: Date.now() };
      const h = opts.skipHistory
        ? replacePresent(history, next)
        : pushHistory(history, next, label, opts.coalesce ?? null, performance.now());
      set({ history: h, project: h.present });
    },
    undo: () => {
      const now = get().history.present;
      const h = undoHistory(get().history);
      const p = keepUnundoable(h.present, now);
      set({ history: { ...h, present: p }, project: p });
    },
    redo: () => {
      const now = get().history.present;
      const h = redoHistory(get().history);
      const p = keepUnundoable(h.present, now);
      set({ history: { ...h, present: p }, project: p });
    },
    loadProject: (p) => {
      const h = createHistory(p);
      set({ history: h, project: p });
    },
  };
});

export const getProject = (): Project => useProjectStore.getState().project;
const commit = (label: string, recipe: (p: Project) => Project, opts?: CommitOptions) =>
  useProjectStore.getState().commit(label, recipe, opts);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function updateProjectFields(label: string, fields: Partial<Project>, coalesce?: string): void {
  commit(label, (p) => ({ ...p, ...fields }), coalesce ? { coalesce } : {});
}

export function removeTrack(trackId: string): void {
  commit('Delete track', (p) => {
    const clips: Record<string, Clip> = {};
    for (const c of Object.values(p.clips)) if (c.trackId !== trackId) clips[c.id] = c;
    // routes that used the deleted track as their sidechain source go too
    const tracks = p.tracks
      .filter((t) => t.id !== trackId)
      .map((t) => (t.modulations.some((m) => m.sourceTrackId === trackId) ? { ...t, modulations: t.modulations.filter((m) => m.sourceTrackId !== trackId) } : t));
    return { ...p, tracks, clips };
  });
}

export function updateTrack(trackId: string, fields: Partial<Track>, label = 'Edit track', opts: CommitOptions = {}): void {
  commit(
    label,
    (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...fields } : t)) }),
    opts,
  );
}

export function setInstrumentPatch(trackId: string, patch: TriOscPatch, presetName: string, opts: CommitOptions = {}): void {
  commit(
    'Edit synth',
    (p) => ({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id === trackId && t.instrument?.type === 'triosc' ? { ...t, instrument: { ...t.instrument, patch, presetName } } : t,
      ),
    }),
    opts,
  );
}

/** Replace a track's instrument config (any type), e.g. a drum kit edit. */
export function setInstrumentConfig(trackId: string, instrument: InstrumentConfig, label: string, opts: CommitOptions = {}): void {
  commit(label, (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId && t.kind === 'instrument' ? { ...t, instrument } : t)) }), opts);
}

export function upsertClips(clips: Clip[], label = 'Edit clip', opts: CommitOptions = {}): void {
  if (clips.length === 0) return;
  commit(
    label,
    (p) => {
      const next = { ...p.clips };
      for (const c of clips) next[c.id] = c;
      return { ...p, clips: next };
    },
    opts,
  );
}

export function removeClips(ids: string[]): void {
  if (ids.length === 0) return;
  commit(ids.length > 1 ? 'Delete clips' : 'Delete clip', (p) => {
    const next = { ...p.clips };
    for (const id of ids) delete next[id];
    return { ...p, clips: next };
  });
}

