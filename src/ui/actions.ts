/**
 * User-level commands shared by the toolbar, timeline and keyboard shortcuts.
 */
import { engine } from '../audio/engine';
import { createId } from '../core/ids';
import { quantize, secondsToTicks, snapToTicks, ticksPerBar } from '../core/time';
import { duplicateClip, setClipLoop, splitClip } from '../project/clipOps';
import { createAudioClip, createMidiClip, createTrack, TRACK_COLORS } from '../project/defaults';
import { INSTRUMENTS, type InstrumentType } from '../instruments/definitions';
import { MAX_TRACKS, type Clip, type Project } from '../project/types';
import { getProject, removeClips, upsertClips, useProjectStore } from '../state/projectStore';
import { uiToast, useUiStore } from '../state/uiStore';

export function currentTick(): number {
  return engine.transport?.getTick() ?? 0;
}

export function gridTicks(): number {
  const p = getProject();
  return snapToTicks(useUiStore.getState().snap, p.timeSignature);
}

export function snapTick(t: number, bypass = false): number {
  return bypass ? Math.round(t) : quantize(t, gridTicks());
}

/** Pass as trackId to force importing onto a new track. */
export const NEW_TRACK = '__new__';

/**
 * Decode audio files and place each as a clip. Uses the given audio track,
 * otherwise the selected audio track, otherwise creates new audio tracks.
 */
export async function importAudioFiles(files: File[], opts: { trackId?: string; tick?: number } = {}): Promise<void> {
  let tick = opts.tick ?? 0;
  for (const file of files) {
    let asset;
    try {
      asset = await engine.importAudioFile(file);
    } catch (e) {
      uiToast('error', e instanceof Error ? e.message : `Could not import ${file.name}`);
      continue;
    }
    const p = getProject();
    let track = p.tracks.find((t) => t.id === opts.trackId && t.kind === 'audio');
    if (opts.trackId !== NEW_TRACK) {
      const sel = useUiStore.getState().selectedTrackId;
      track ??= p.tracks.find((t) => t.id === sel && t.kind === 'audio');
      track ??= p.tracks.find((t) => t.kind === 'audio' && !Object.values(p.clips).some((c) => c.trackId === t.id));
    }
    let newTrack = null;
    if (!track) {
      if (p.tracks.length >= MAX_TRACKS) {
        uiToast('error', `Can't import "${file.name}": all ${MAX_TRACKS} tracks are in use and none is an empty audio track.`);
        continue;
      }
      newTrack = createTrack('audio', p.tracks.length);
      newTrack.name = asset.ref.name.slice(0, 24);
      track = newTrack;
    }
    const length = Math.max(1, Math.round(secondsToTicks(asset.ref.durationSec, p.bpm)));
    const clip = createAudioClip(track.id, asset.ref.id, asset.ref.name, Math.round(tick), length);
    const trackToAdd = newTrack;
    useProjectStore.getState().commit('Import audio', (prev) => ({
      ...prev,
      tracks: trackToAdd ? [...prev.tracks, trackToAdd] : prev.tracks,
      assets: { ...prev.assets, [asset.ref.id]: asset.ref },
      clips: { ...prev.clips, [clip.id]: clip },
    }));
    useUiStore.getState().set({ selectedClipIds: [clip.id], selectedTrackId: track.id });
    // multiple files in one drop go one after another on separate tracks if new, else in sequence
    if (!trackToAdd) tick += length;
  }
}

/** What a new track can be: an audio track, or any registered instrument. */
export type NewTrackSpec = 'audio' | InstrumentType;

export function addNewTrack(spec: NewTrackSpec): void {
  const p = getProject();
  if (p.tracks.length >= MAX_TRACKS) {
    uiToast('error', `A project can have at most ${MAX_TRACKS} tracks.`);
    return;
  }
  const track = spec === 'audio' ? createTrack('audio', p.tracks.length) : createTrack('instrument', p.tracks.length, INSTRUMENTS[spec].createConfig());
  // pick a color no other track uses, when one is left
  const used = new Set(p.tracks.map((t) => t.color));
  track.color = TRACK_COLORS.find((c) => !used.has(c)) ?? track.color;
  useProjectStore.getState().commit(`Add ${spec === 'audio' ? 'audio' : INSTRUMENTS[spec].label} track`, (prev) => ({ ...prev, tracks: [...prev.tracks, track] }));
  useUiStore.getState().set({ selectedTrackId: track.id });
}

/** Create a one-bar MIDI clip at the bar containing `tick` and open it in the piano roll. */
export function createMidiClipAt(trackId: string, tick: number): void {
  const p = getProject();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== 'instrument') return;
  const bar = ticksPerBar(p.timeSignature);
  const start = Math.max(0, Math.floor(tick / bar) * bar);
  // don't stack on top of an existing clip: start after any clip covering this bar
  const covering = Object.values(p.clips).filter((c) => c.trackId === trackId && c.start < start + bar && c.start + c.length > start);
  const s = covering.length ? Math.ceil(Math.max(...covering.map((c) => c.start + c.length)) / bar) * bar : start;
  const clip = createMidiClip(trackId, s, bar);
  clip.name = `${track.name} ${Object.values(p.clips).filter((c) => c.trackId === trackId).length + 1}`;
  upsertClips([clip], 'Create MIDI clip');
  openClipEditor(clip.id);
}

export function openClipEditor(clipId: string): void {
  const clip = getProject().clips[clipId];
  if (!clip) return;
  useUiStore.getState().set({ selectedClipIds: [clipId], selectedTrackId: clip.trackId, editorClipId: clipId, bottomPanel: 'editor' });
}

function selectedClips(p: Project): Clip[] {
  return useUiStore
    .getState()
    .selectedClipIds.map((id) => p.clips[id])
    .filter((c): c is Clip => c !== undefined);
}

export function deleteSelectedClips(): void {
  const ids = useUiStore.getState().selectedClipIds.filter((id) => getProject().clips[id]);
  if (!ids.length) return;
  removeClips(ids);
  useUiStore.getState().set({ selectedClipIds: [] });
}

export function duplicateSelectedClips(): void {
  const p = getProject();
  const sel = selectedClips(p);
  if (!sel.length) return;
  // duplicate the selection as a block, right after its end
  const start = Math.min(...sel.map((c) => c.start));
  const end = Math.max(...sel.map((c) => c.start + c.length));
  const copies = sel.map((c) => duplicateClip(c, c.start + (end - start)));
  upsertClips(copies, 'Duplicate');
  useUiStore.getState().set({ selectedClipIds: copies.map((c) => c.id) });
}

export function splitSelectedAtPlayhead(): void {
  const p = getProject();
  const at = Math.round(currentTick());
  const sel = selectedClips(p);
  const targets = sel.length ? sel : Object.values(p.clips).filter((c) => c.start < at && c.start + c.length > at && c.trackId === useUiStore.getState().selectedTrackId);
  const newSel: string[] = [];
  useProjectStore.getState().commit('Split', (prev) => {
    const clips = { ...prev.clips };
    let changed = false;
    for (const c of targets) {
      const res = splitClip(c, at, prev.bpm);
      if (!res) continue;
      changed = true;
      delete clips[c.id];
      clips[res[0].id] = res[0];
      clips[res[1].id] = res[1];
      newSel.push(res[1].id);
    }
    return changed ? { ...prev, clips } : prev;
  });
  if (newSel.length) useUiStore.getState().set({ selectedClipIds: newSel });
}

export function toggleLoopSelectedClips(): void {
  const p = getProject();
  const sel = selectedClips(p);
  if (!sel.length) return;
  const on = !sel.every((c) => c.loop);
  upsertClips(sel.map((c) => setClipLoop(c, on, p.bpm)), on ? 'Loop clip' : 'Unloop clip');
}

// --- clipboard (clips) ---

let clipboard: { clips: Clip[]; origin: number } | null = null;

export function copySelectedClips(): void {
  const sel = selectedClips(getProject());
  if (!sel.length) return;
  clipboard = { clips: sel.map((c) => structuredClone(c)), origin: Math.min(...sel.map((c) => c.start)) };
}

export function pasteClips(): void {
  if (!clipboard) return;
  const p = getProject();
  const at = snapTick(currentTick());
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const copies = clipboard.clips
    .filter((c) => trackIds.has(c.trackId))
    .map((c) => {
      const d = duplicateClip(c, at + (c.start - (clipboard as { origin: number }).origin));
      return { ...d, id: createId('clp') };
    });
  upsertClips(copies, 'Paste');
  useUiStore.getState().set({ selectedClipIds: copies.map((c) => c.id) });
}

export function togglePlay(): void {
  void engine.resume();
  engine.transport?.togglePlay();
}

export function stopTransport(): void {
  engine.transport?.stop();
}

export function selectAllClips(): void {
  const ids = Object.keys(getProject().clips);
  useUiStore.getState().set({ selectedClipIds: ids });
}

/**
 * Nudge the selected clips by `dTicks` and/or move them `dTrack` tracks up or
 * down. A vertical move only happens if every clip lands on a track of the
 * right kind (audio clips → audio tracks, MIDI → instrument tracks).
 */
export function nudgeSelectedClips(dTicks: number, dTrack: number): void {
  const p = getProject();
  const sel = selectedClips(p);
  if (!sel.length) return;
  const minStart = Math.min(...sel.map((c) => c.start));
  const dt = Math.max(dTicks, -minStart);
  const idx = new Map(p.tracks.map((t, i) => [t.id, i]));
  let dk = dTrack;
  if (dk !== 0) {
    const ok = sel.every((c) => {
      const t = p.tracks[(idx.get(c.trackId) ?? 0) + dk];
      return t && (c.kind === 'audio' ? t.kind === 'audio' : t.kind === 'instrument');
    });
    if (!ok) dk = 0;
  }
  if (dt === 0 && dk === 0) return;
  const moved = sel.map((c) => ({ ...c, start: c.start + dt, trackId: p.tracks[(idx.get(c.trackId) ?? 0) + dk]?.id ?? c.trackId }));
  upsertClips(moved, 'Nudge clips', { coalesce: `nudge-${sel.map((c) => c.id).join(',')}` });
}

export function renameClip(clipId: string): void {
  const c = getProject().clips[clipId];
  if (!c) return;
  const name = prompt('Clip name:', c.name)?.trim();
  if (name && name !== c.name) upsertClips([{ ...c, name: name.slice(0, 48) }], 'Rename clip');
}
