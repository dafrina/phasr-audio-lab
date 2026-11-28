/** Store commands for automation lanes. All lane edits are undoable project edits. */
import { engine } from '../audio/engine';
import {
  addPoint,
  createLane,
  deletePoint,
  movePoint,
  sameTarget,
  setShapes,
  staticValue,
  targetInfo,
  writeValue,
} from '../project/automation';
import type { AutomationLane, AutomationTarget, Project } from '../project/types';
import type { AutomationShape } from '../project/curves';
import { copyPoints, duplicatePoints, pastePoints, removePoints, type PointClipboard } from '../project/automationClipboard';
import { getProject, useProjectStore, type CommitOptions } from './projectStore';
import { uiToast, useUiStore } from './uiStore';

export function findLane(p: Project, trackId: string, target: AutomationTarget): AutomationLane | undefined {
  return p.tracks.find((t) => t.id === trackId)?.automation.find((l) => sameTarget(l.target, target));
}

function editLanes(trackId: string, label: string, fn: (lanes: AutomationLane[]) => AutomationLane[], opts: CommitOptions = {}): void {
  useProjectStore.getState().commit(
    label,
    (p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return p;
      const next = fn(track.automation);
      if (next === track.automation) return p;
      return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, automation: next } : t)) };
    },
    opts,
  );
}

export function showLane(trackId: string, laneId: string | null): void {
  const ui = useUiStore.getState();
  ui.set({ shownLanes: { ...ui.shownLanes, [trackId]: laneId } });
}

/** Create a lane for a parameter (seeded with its current value) or show the existing one. */
export function automate(trackId: string, target: AutomationTarget): void {
  const p = getProject();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const existing = findLane(p, trackId, target);
  if (existing) {
    showLane(trackId, existing.id);
    useUiStore.getState().set({ automationMode: true });
    return;
  }
  const info = targetInfo(track, target);
  const v = staticValue(track, target);
  if (!info || v === null) return;
  const lane = createLane(target, v, 0);
  editLanes(trackId, `Automate ${info.fullLabel}`, (lanes) => [...lanes, lane]);
  showLane(trackId, lane.id);
  useUiStore.getState().set({ automationMode: true });
  uiToast('info', `Automation lane “${info.fullLabel}” created. Click on the track in Automation mode (A) to add points, or move the knob during playback to record.`);
}

export function deleteLane(trackId: string, laneId: string): void {
  editLanes(trackId, 'Delete automation', (lanes) => lanes.filter((l) => l.id !== laneId));
  const ui = useUiStore.getState();
  if (ui.shownLanes[trackId] === laneId) showLane(trackId, null);
}

export function setLaneEnabled(trackId: string, laneId: string, enabled: boolean): void {
  editLanes(trackId, enabled ? 'Enable automation' : 'Disable automation', (lanes) => lanes.map((l) => (l.id === laneId ? { ...l, enabled } : l)));
}

function withLane(trackId: string, laneId: string, label: string, fn: (l: AutomationLane) => AutomationLane, opts: CommitOptions = {}): void {
  editLanes(trackId, label, (lanes) => lanes.map((l) => (l.id === laneId ? fn(l) : l)), opts);
}

function specFor(trackId: string, laneId: string) {
  const p = getProject();
  const track = p.tracks.find((t) => t.id === trackId);
  const lane = track?.automation.find((l) => l.id === laneId);
  return track && lane ? targetInfo(track, lane.target)?.spec ?? null : null;
}

export function addLanePoint(trackId: string, laneId: string, tick: number, value: number, coalesce?: string): string | null {
  const spec = specFor(trackId, laneId);
  if (!spec) return null;
  let id: string | null = null;
  withLane(trackId, laneId, 'Add automation point', (l) => {
    const [next, pid] = addPoint(l, tick, value, spec);
    id = pid;
    return next;
  }, coalesce ? { coalesce } : {});
  return id;
}

export function moveLanePoint(trackId: string, laneId: string, pointId: string, tick: number, value: number, coalesce: string): void {
  const spec = specFor(trackId, laneId);
  if (spec) withLane(trackId, laneId, 'Move automation point', (l) => movePoint(l, pointId, tick, value, spec), { coalesce });
}

export function deleteLanePoint(trackId: string, laneId: string, pointId: string): void {
  withLane(trackId, laneId, 'Delete automation point', (l) => deletePoint(l, pointId));
}

/**
 * Shape the segments that start at `pointIds` (undefined = linear). A drag passes
 * its gesture key as `coalesce`, so bending a segment is one undo step.
 */
export function setLaneShapes(trackId: string, laneId: string, pointIds: readonly string[], shape: AutomationShape | undefined, coalesce?: string): void {
  if (!pointIds.length) return;
  withLane(trackId, laneId, 'Automation curve', (l) => setShapes(l, pointIds, shape), coalesce ? { coalesce } : {});
}

// --- writing automation by moving a knob ---

const gestures = new Map<string, number>();

/**
 * Called when an automated knob moves. While playing, successive moves in one
 * gesture replace the curve between the previous and current playhead
 * position (recording); while stopped, it sets the value at the playhead.
 */
export function writeAutomation(trackId: string, target: AutomationTarget, value: number, gestureKey: string): void {
  const p = getProject();
  const lane = findLane(p, trackId, target);
  const track = p.tracks.find((t) => t.id === trackId);
  if (!lane || !track) return;
  const spec = targetInfo(track, target)?.spec;
  if (!spec) return;
  const tr = engine.transport;
  const tick = Math.max(0, Math.round(tr?.getTick() ?? 0));
  const playing = tr?.isPlaying() ?? false;
  const from = playing ? (gestures.get(gestureKey) ?? null) : null;
  gestures.set(gestureKey, tick);
  withLane(trackId, lane.id, 'Write automation', (l) => writeValue(l, from, tick, value, spec, playing ? 0 : 30), { coalesce: gestureKey });
}

export function endAutomationGesture(gestureKey: string): void {
  gestures.delete(gestureKey);
}

// --- copy / cut / paste / duplicate of points (project/automationClipboard) ---

let pointClipboard: PointClipboard | null = null;

export function hasPointClipboard(): boolean {
  return pointClipboard !== null;
}

/** Copy points of a lane to the point clipboard (false when none of them exists). */
export function copyLanePoints(trackId: string, laneId: string, ids: readonly string[]): boolean {
  const lane = getProject().tracks.find((t) => t.id === trackId)?.automation.find((l) => l.id === laneId);
  const spec = specFor(trackId, laneId);
  const clip = lane && spec ? copyPoints(lane, ids, spec) : null;
  if (clip) pointClipboard = clip;
  return clip !== null;
}

/** Cut: copy, then remove the points (one undo step). */
export function cutLanePoints(trackId: string, laneId: string, ids: readonly string[]): boolean {
  if (!copyLanePoints(trackId, laneId, ids)) return false;
  withLane(trackId, laneId, 'Cut automation points', (l) => removePoints(l, ids));
  return true;
}

export function deleteLanePoints(trackId: string, laneId: string, ids: readonly string[]): void {
  if (ids.length) withLane(trackId, laneId, ids.length > 1 ? 'Delete automation points' : 'Delete automation point', (l) => removePoints(l, ids));
}

/** Paste the point clipboard into a lane with its first point at `at` (one undo step); the new ids, or null. */
export function pasteLanePoints(trackId: string, laneId: string, at: number): string[] | null {
  const clip = pointClipboard;
  const spec = specFor(trackId, laneId);
  if (!clip || !spec) return null;
  let ids: string[] | null = null;
  withLane(trackId, laneId, 'Paste automation points', (l) => {
    const r = pastePoints(l, clip, at, spec);
    ids = r.ids;
    return r.lane;
  });
  return ids;
}

/** Duplicate points right after themselves (one undo step); the copies' ids, or null. */
export function duplicateLanePoints(trackId: string, laneId: string, ids: readonly string[], beatTicks: number): string[] | null {
  const spec = specFor(trackId, laneId);
  const lane = getProject().tracks.find((t) => t.id === trackId)?.automation.find((l) => l.id === laneId);
  const r = lane && spec ? duplicatePoints(lane, ids, spec, beatTicks) : null;
  if (!r) return null;
  withLane(trackId, laneId, 'Duplicate automation points', () => r.lane);
  return r.ids;
}
