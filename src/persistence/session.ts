/**
 * Project lifecycle: autosave, open/new/duplicate/delete, archive export and
 * import. The editor always works on one "current" project; every change is
 * autosaved shortly after it happens, so there is no unsaved state to lose.
 */
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { recorder } from '../audio/recorder';
import { createId } from '../core/ids';
import { createProject } from '../project/defaults';
import { migrateProject, ProjectFormatError } from '../project/migrations';
import type { Project } from '../project/types';
import { getProject, useProjectStore } from '../state/projectStore';
import { uiToast, useUiStore } from '../state/uiStore';
import { buildArchive, parseArchive, type ArchiveAsset } from './archive';
import {
  assetBackend,
  deleteAsset,
  deleteProjectRecord,
  getAsset,
  getProjectRecord,
  hasAsset,
  listAssetIds,
  listProjectRecords,
  openDb,
  putAsset,
  putProjectRecord,
  requestPersistence,
  type ProjectMeta,
  type ProjectRecord,
} from './db';
import { downloadBlob, safeFileName } from './download';

export type PersistStatus = 'starting' | 'saved' | 'dirty' | 'saving' | 'error' | 'unavailable' | 'readonly';

interface PersistState {
  status: PersistStatus;
  lastSavedAt: number | null;
  error: string | null;
  backend: 'opfs' | 'indexeddb' | null;
  /** a blocking operation in progress (shown as an overlay), e.g. "Opening project…" */
  busy: string | null;
}

export const usePersistStore = create<PersistState>(() => ({ status: 'starting', lastSavedAt: null, error: null, backend: null, busy: null }));
const setP = (s: Partial<PersistState>) => usePersistStore.setState(s);

const LAST_KEY = 'phasr.lastProjectId';
const AUTOSAVE_MS = 1200;

let available = false;
let loading = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
let again = false;
/** asset ids known to be in storage (avoids re-writing large files on every save) */
const stored = new Set<string>();

// ---------------------------------------------------------------------------
// One writer per project across tabs (Web Locks). A second tab that opens the
// same project becomes read-only instead of silently overwriting the first.
// ---------------------------------------------------------------------------

let readOnly = false;
let releaseLock: (() => void) | null = null;
const READONLY_MSG = 'This project is open in another tab. Changes here are not saved — use “Take over” to edit it here.';

function lockName(id: string): string {
  return `phasr-project:${id}`;
}

/** Hold the project's lock for as long as it is open here. Resolves true if acquired. */
function acquireLock(id: string, steal = false): Promise<boolean> {
  releaseLock?.();
  releaseLock = null;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(true); // no Web Locks: single-tab behaviour
  return new Promise<boolean>((acquired) => {
    locks
      .request(lockName(id), steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) {
          acquired(false);
          return;
        }
        acquired(true);
        await new Promise<void>((done) => (releaseLock = done));
      })
      .catch(() => {
        // our lock was stolen by another tab that chose "Take over"
        if (getProject().id === id && !readOnly) {
          readOnly = true;
          if (timer) clearTimeout(timer);
          setP({ status: 'readonly', error: 'Another tab took over this project. Changes here are no longer saved.' });
          uiToast('error', 'Another tab took over this project; this tab is now read-only.');
        }
      });
  });
}

function applyLockResult(acquired: boolean): void {
  readOnly = !acquired;
  if (readOnly) {
    setP({ status: 'readonly', error: READONLY_MSG });
    uiToast('error', READONLY_MSG);
  }
}

/** Claim the open project in this tab (the other tab becomes read-only). */
export async function takeOver(): Promise<void> {
  const ok = await acquireLock(getProject().id, true);
  readOnly = !ok;
  if (ok) {
    setP({ status: 'dirty', error: null });
    await saveNow();
    uiToast('info', 'This tab now owns the project; changes are saved again.');
  }
}

export function isReadOnly(): boolean {
  return readOnly;
}

function remember(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // storage blocked: only the "reopen last project" convenience is lost
  }
}

function recordFor(p: Project): ProjectRecord {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: Date.now(),
    trackCount: p.tracks.length,
    clipCount: Object.keys(p.clips).length,
    assetIds: Object.keys(p.assets),
    data: JSON.stringify(p),
  };
}

/** Write any of the project's assets that aren't in storage yet. Returns names of assets with no bytes available. */
async function persistAssets(p: Project): Promise<string[]> {
  const missing: string[] = [];
  for (const [id, ref] of Object.entries(p.assets)) {
    if (stored.has(id)) continue;
    if (await hasAsset(id)) {
      stored.add(id);
      continue;
    }
    const a = engine.assets.get(id);
    if (!a?.bytes) {
      missing.push(ref.name);
      continue;
    }
    await putAsset({ id, mime: a.mime, bytes: a.bytes });
    stored.add(id);
  }
  return missing;
}

async function doSave(): Promise<void> {
  if (readOnly) return;
  const p = getProject();
  setP({ status: 'saving' });
  try {
    const missing = await persistAssets(p);
    await putProjectRecord(recordFor(p));
    remember(p.id);
    setP({ status: again ? 'dirty' : 'saved', lastSavedAt: Date.now(), error: missing.length ? `Audio not available to save: ${missing.join(', ')}` : null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const quota = /quota/i.test(msg);
    setP({ status: 'error', error: quota ? 'Browser storage is full. Free space, delete old projects, or export an archive.' : `Saving failed: ${msg}` });
    uiToast('error', quota ? 'Could not save: browser storage is full. Export an archive to keep your work.' : `Could not save the project: ${msg}`);
  }
}

/** Save now (also used by Ctrl+S). Saves are serialized; a change during a save triggers one more. */
export async function saveNow(): Promise<void> {
  if (!available) {
    uiToast('error', 'Local storage is unavailable in this browser session. Use “Export archive” to keep your work.');
    return;
  }
  if (readOnly) {
    setP({ status: 'readonly', error: READONLY_MSG });
    return;
  }
  if (timer) clearTimeout(timer);
  timer = null;
  if (saving) {
    again = true;
    return saving;
  }
  saving = (async () => {
    do {
      again = false;
      await doSave();
    } while (again);
  })().finally(() => (saving = null));
  return saving;
}

function scheduleAutosave(): void {
  if (!available || loading) return;
  if (readOnly) {
    setP({ status: 'readonly' });
    return;
  }
  setP({ status: 'dirty' });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), AUTOSAVE_MS);
}

let initPromise: Promise<void> | null = null;

/**
 * Called at startup: open storage, restore the last project, start autosaving.
 * Idempotent — React StrictMode runs effects twice in development, and a second
 * run would contend for this tab's own project lock and turn it read-only.
 */
export function initPersistence(): Promise<void> {
  initPromise ??= doInitPersistence();
  return initPromise;
}

async function doInitPersistence(): Promise<void> {
  try {
    await openDb();
    available = true;
    setP({ backend: await assetBackend() });
    void requestPersistence();
  } catch (e) {
    available = false;
    const msg = e instanceof Error ? e.message : String(e);
    setP({ status: 'unavailable', error: msg });
    uiToast('error', msg);
    return;
  }
  useProjectStore.subscribe((s, prev) => {
    if (s.project !== prev.project) scheduleAutosave();
  });
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    last = null;
  }
  if (last && (await getProjectRecord(last))) {
    await openProject(last, { quiet: true });
  } else {
    applyLockResult(await acquireLock(getProject().id));
    await saveNow();
  }
}

/** Reset transient UI/engine state before swapping the current project. */
function resetForSwitch(): void {
  engine.panic();
  recorder.closeInput();
  useUiStore.getState().set({
    selectedClipIds: [],
    selectedTrackId: null,
    editorClipId: null,
    bottomPanel: 'none',
    synthTrackId: null,
    fxTrackId: null,
    shownLanes: {},
    peqSelected: {},
    scrollX: 0,
  });
}

/** Decode a project's audio from storage into the engine, then make it current. */
async function activate(project: Project, quiet: boolean): Promise<void> {
  await engine.init();
  const ctx = engine.ctx;
  if (!ctx) throw new Error('Audio engine unavailable');
  resetForSwitch();
  engine.assets.clear();
  const missing: string[] = [];
  for (const [id, ref] of Object.entries(project.assets)) {
    const a = await getAsset(id).catch(() => null);
    if (!a) {
      missing.push(ref.name);
      continue;
    }
    stored.add(id);
    try {
      await engine.assets.decodeBytes(ctx, a.bytes, ref.name, a.mime, id);
    } catch {
      missing.push(`${ref.name} (could not decode)`);
    }
  }
  const acquired = await acquireLock(project.id);
  // decode first, then load: instruments and clips find their samples immediately
  useProjectStore.getState().loadProject(project);
  applyLockResult(acquired);
  engine.transport?.seek(0);
  remember(project.id);
  if (missing.length) uiToast('error', `Missing audio in “${project.name}”: ${missing.join(', ')}. Affected clips are marked “missing audio”.`);
  else if (!quiet) uiToast('info', `Opened “${project.name}”.`);
}

export async function openProject(id: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  if (timer || saving) await saveNow(); // never lose the current project's last edits
  loading = true;
  setP({ busy: 'Opening project…' });
  try {
    const rec = await getProjectRecord(id);
    if (!rec) throw new ProjectFormatError('That project no longer exists in local storage.');
    let project: Project;
    try {
      project = migrateProject(JSON.parse(rec.data));
    } catch (e) {
      throw new ProjectFormatError(`The saved project is damaged: ${e instanceof Error ? e.message : String(e)}`);
    }
    await activate(project, !!opts.quiet);
    if (!readOnly) setP({ status: 'saved', lastSavedAt: rec.updatedAt, error: null });
    return true;
  } catch (e) {
    uiToast('error', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    loading = false;
    setP({ busy: null });
  }
}

export async function newProject(): Promise<void> {
  if (timer || saving) await saveNow();
  loading = true;
  try {
    await activate(createProject('Untitled Project'), true);
  } finally {
    loading = false;
  }
  await saveNow();
}

/** Save a copy of a stored project (or the current one) under a new id; returns the copy's id. */
export async function duplicateProject(id = getProject().id, open = false): Promise<string | null> {
  if (id === getProject().id) await saveNow();
  const rec = await getProjectRecord(id);
  if (!rec) return null;
  const p = migrateProject(JSON.parse(rec.data));
  const copy: Project = { ...p, id: createId('prj'), name: `${p.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
  await putProjectRecord(recordFor(copy));
  if (open) await openProject(copy.id);
  else uiToast('info', `Saved a copy: “${copy.name}”.`);
  return copy.id;
}

/** Permanently delete a stored project (not the open one) and audio no other project uses. */
export async function deleteProject(id: string): Promise<void> {
  if (id === getProject().id) {
    uiToast('error', 'You can’t delete the open project. Open or create another project first.');
    return;
  }
  await deleteProjectRecord(id);
  const keep = new Set<string>(Object.keys(getProject().assets));
  for (const meta of await listProjectRecords()) for (const a of meta.assetIds) keep.add(a);
  for (const assetId of await listAssetIds()) {
    if (!keep.has(assetId)) {
      await deleteAsset(assetId);
      stored.delete(assetId);
    }
  }
}

export function listProjects(): Promise<ProjectMeta[]> {
  return available ? listProjectRecords() : Promise.resolve([]);
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

async function gatherAssets(p: Project): Promise<{ assets: ArchiveAsset[]; missing: string[] }> {
  const assets: ArchiveAsset[] = [];
  const missing: string[] = [];
  for (const [id, ref] of Object.entries(p.assets)) {
    const live = engine.assets.get(id);
    if (live?.bytes) {
      assets.push({ id, mime: live.mime, bytes: new Uint8Array(live.bytes) });
      continue;
    }
    const s = available ? await getAsset(id).catch(() => null) : null;
    if (s) assets.push({ id, mime: s.mime, bytes: new Uint8Array(s.bytes) });
    else missing.push(ref.name);
  }
  return { assets, missing };
}

/** Download a .phasr archive of the current project (or a stored one). */
export async function exportArchive(id = getProject().id): Promise<void> {
  let project = getProject();
  if (id !== project.id) {
    const rec = await getProjectRecord(id);
    if (!rec) return uiToast('error', 'Project not found.');
    project = migrateProject(JSON.parse(rec.data));
  }
  setP({ busy: 'Building archive…' });
  try {
    const { assets, missing } = await gatherAssets(project);
    const zip = buildArchive(project, assets);
    downloadBlob(new Blob([zip], { type: 'application/zip' }), `${safeFileName(project.name)}.phasr`);
    uiToast(missing.length ? 'error' : 'info', missing.length ? `Archive exported without missing audio: ${missing.join(', ')}` : `Exported “${project.name}” (${assets.length} audio file${assets.length === 1 ? '' : 's'}, ${(zip.byteLength / 1e6).toFixed(1)} MB).`);
  } finally {
    setP({ busy: null });
  }
}

/** Import a .phasr archive as a new project and open it. */
export async function importArchive(file: File): Promise<boolean> {
  setP({ busy: 'Importing archive…' });
  try {
    const parsed = await parseArchive(new Uint8Array(await file.arrayBuffer()));
    if (!available) {
      // no storage: still open it for this session
      loading = true;
      await engine.init();
      const ctx = engine.ctx;
      if (ctx) {
        resetForSwitch();
        engine.assets.clear();
        for (const a of parsed.assets) await engine.assets.decodeBytes(ctx, a.bytes.slice().buffer, parsed.project.assets[a.id]?.name ?? a.id, a.mime, a.id).catch(() => undefined);
      }
      useProjectStore.getState().loadProject(parsed.project);
      loading = false;
      return true;
    }
    for (const a of parsed.assets) {
      if (!(await hasAsset(a.id))) await putAsset({ id: a.id, mime: a.mime, bytes: a.bytes.slice().buffer });
      stored.add(a.id);
    }
    await putProjectRecord(recordFor(parsed.project));
    const ok = await openProject(parsed.project.id, { quiet: true });
    if (ok) uiToast(parsed.missing.length ? 'error' : 'info', parsed.missing.length ? `Imported “${parsed.project.name}”, but the archive lacks ${parsed.missing.length} audio file(s).` : `Imported “${parsed.project.name}”.`);
    return ok;
  } catch (e) {
    uiToast('error', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    loading = false;
    setP({ busy: null });
  }
}
