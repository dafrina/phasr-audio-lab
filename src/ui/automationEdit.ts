/**
 * Keyboard and menu edits of automation points in Automation mode: copy, cut,
 * paste, duplicate, delete (Ctrl/Cmd + C / X / V / D, Delete). Each returns
 * whether it applied, so the shortcut falls back to the clip version otherwise.
 */
import { engine } from '../audio/engine';
import { ticksPerBeatUnit } from '../core/time';
import { copyLanePoints, cutLanePoints, deleteLanePoints, duplicateLanePoints, hasPointClipboard, pasteLanePoints } from '../state/automationActions';
import { getProject } from '../state/projectStore';
import { useUiStore } from '../state/uiStore';
import { snapTick } from './actions';
import { getAutoHover, getAutoSelection, setAutoSelection, type AutoSelection } from './timeline/autoSelection';

/** the current selection, if Automation mode is on and its lane and points still exist */
function liveSelection(): AutoSelection | null {
  const sel = getAutoSelection();
  if (!sel || !useUiStore.getState().automationMode) return null;
  const lane = getProject().tracks.find((t) => t.id === sel.trackId)?.automation.find((l) => l.id === sel.laneId);
  const ids = lane ? sel.ids.filter((id) => lane.points.some((p) => p.id === id)) : [];
  return ids.length ? { ...sel, ids } : null;
}

export function copyAutomation(): boolean {
  const sel = liveSelection();
  return !!sel && copyLanePoints(sel.trackId, sel.laneId, sel.ids);
}

export function cutAutomation(): boolean {
  const sel = liveSelection();
  if (!sel || !cutLanePoints(sel.trackId, sel.laneId, sel.ids)) return false;
  setAutoSelection(null);
  return true;
}

export function deleteAutomationPoints(): boolean {
  const sel = liveSelection();
  if (!sel) return false;
  deleteLanePoints(sel.trackId, sel.laneId, sel.ids);
  setAutoSelection(null);
  return true;
}

export function duplicateAutomation(): boolean {
  const sel = liveSelection();
  if (!sel) return false;
  const ids = duplicateLanePoints(sel.trackId, sel.laneId, sel.ids, ticksPerBeatUnit(getProject().timeSignature));
  if (ids) setAutoSelection({ ...sel, ids });
  return !!ids;
}

/**
 * Paste the copied points. `at` given (a menu at a clicked spot): there, in that
 * lane. Otherwise at the lane position under the pointer, or at the playhead in
 * the lane of the selection or the selected track's shown lane. Snaps to the grid.
 */
export function pasteAutomation(at?: { trackId: string; laneId: string; tick: number }): boolean {
  const ui = useUiStore.getState();
  if (!ui.automationMode || !hasPointClipboard()) return false;
  const p = getProject();
  const shown = (trackId: string | null) => {
    const laneId = trackId ? ui.shownLanes[trackId] : null;
    return trackId && laneId && p.tracks.find((t) => t.id === trackId)?.automation.some((l) => l.id === laneId) ? { trackId, laneId } : null;
  };
  const hover = getAutoHover();
  const sel = getAutoSelection();
  const dest: { trackId: string; laneId: string; tick?: number } | null =
    at ?? (hover && shown(hover.trackId)?.laneId === hover.laneId ? hover : null) ?? (sel ? shown(sel.trackId) : null) ?? shown(ui.selectedTrackId);
  if (!dest) return false;
  const tick = snapTick(Math.max(0, dest.tick ?? engine.transport?.getTick() ?? 0));
  const ids = pasteLanePoints(dest.trackId, dest.laneId, tick);
  if (ids) setAutoSelection({ trackId: dest.trackId, laneId: dest.laneId, ids });
  return !!ids;
}
