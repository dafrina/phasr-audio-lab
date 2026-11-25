/** Store commands for modulation (sidechain) routes. */
import { createRoute, modParamInfo, sourceKinds, wouldCreateCycle } from '../project/modulation';
import { sameTarget } from '../project/automation';
import type { AutomationTarget, ModRoute, ModSourceKind } from '../project/types';
import { getProject, useProjectStore, type CommitOptions } from './projectStore';
import { sidechainNoteFor } from '../instruments/definitions';
import { openTrackDevices, uiToast } from './uiStore';

function editRoutes(trackId: string, label: string, fn: (r: ModRoute[]) => ModRoute[], opts: CommitOptions = {}): void {
  useProjectStore.getState().commit(
    label,
    (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, modulations: fn(t.modulations) } : t)) }),
    opts,
  );
}

/** Create a route; refuses duplicates and routes that would form an audio feedback cycle. */
export function addModRoute(ownerTrackId: string, sourceTrackId: string, source: ModSourceKind, target: AutomationTarget, depth?: number): ModRoute | null {
  const p = getProject();
  const owner = p.tracks.find((t) => t.id === ownerTrackId);
  const src = p.tracks.find((t) => t.id === sourceTrackId);
  if (!owner || !src) return null;
  if (!sourceKinds(src).includes(source)) {
    uiToast('error', `${src.name} has no MIDI notes to trigger from — use its audio level instead.`);
    return null;
  }
  const existing = owner.modulations.find((m) => m.sourceTrackId === sourceTrackId && m.source === source && sameTarget(m.target, target));
  if (existing) {
    openTrackDevices(ownerTrackId);
    return existing;
  }
  const route = createRoute(owner, sourceTrackId, source, target);
  if (!route) return null;
  if (depth !== undefined) route.depth = depth;
  if (wouldCreateCycle(p, ownerTrackId, route)) {
    uiToast('error', `Can't route ${src.name}'s audio here: it would create a feedback loop (${owner.name} already feeds ${src.name}). Use MIDI notes as the source, or remove the other route.`);
    return null;
  }
  const label = modParamInfo(owner, target)?.fullLabel ?? 'parameter';
  editRoutes(ownerTrackId, `Sidechain ${label} from ${src.name}`, (r) => [...r, route]);
  openTrackDevices(ownerTrackId);
  return route;
}

/** One-click ducking: the owner's volume dips when the source plays. MIDI for instruments (tightest), audio otherwise. */
export function duckFrom(ownerTrackId: string, sourceTrackId: string): void {
  const src = getProject().tracks.find((t) => t.id === sourceTrackId);
  if (!src) return;
  const kind: ModSourceKind = src.kind === 'instrument' ? 'midi' : 'audio';
  const r = addModRoute(ownerTrackId, sourceTrackId, kind, { kind: 'track', param: 'volumeDb' }, -12);
  // a drum rack source ducks from its kick pad only (registry-defined), not every hit
  const note = kind === 'midi' ? sidechainNoteFor(src.instrument) : null;
  if (r && note !== null) updateModRoute(ownerTrackId, r.id, { note });
  if (r) uiToast('info', `${getProject().tracks.find((t) => t.id === ownerTrackId)?.name} now ducks from ${src.name} (${kind === 'midi' ? 'MIDI notes' : 'audio level'}). Tweak depth and release in the track devices panel.`);
}

export function updateModRoute(ownerTrackId: string, routeId: string, part: Partial<ModRoute>, coalesce?: string): void {
  const p = getProject();
  const owner = p.tracks.find((t) => t.id === ownerTrackId);
  const cur = owner?.modulations.find((m) => m.id === routeId);
  if (!owner || !cur) return;
  const next = { ...cur, ...part };
  if (part.enabled && !cur.enabled) {
    const others = { ...p, tracks: p.tracks.map((t) => (t.id === ownerTrackId ? { ...t, modulations: t.modulations.filter((m) => m.id !== routeId) } : t)) };
    if (wouldCreateCycle(others, ownerTrackId, next)) {
      uiToast('error', 'Enabling this route would create an audio feedback loop.');
      return;
    }
  }
  editRoutes(ownerTrackId, 'Edit sidechain', (r) => r.map((m) => (m.id === routeId ? next : m)), coalesce ? { coalesce } : {});
}

export function removeModRoute(ownerTrackId: string, routeId: string): void {
  editRoutes(ownerTrackId, 'Remove sidechain', (r) => r.filter((m) => m.id !== routeId));
}
