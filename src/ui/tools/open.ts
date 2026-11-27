/**
 * Opening the playing tools' windows (kept apart from the windows themselves,
 * which load on demand): create the tool on the track if it has none yet.
 */
import { defaultArp } from '../../arp/arp';
import { defaultChordTool } from '../../chords/theory';
import { getProject, updateTrack } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';

/** Create the Arp-Ape-ator on a track (if needed) and open its window. */
export function openArp(trackId: string): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== 'instrument') return;
  if (!t.arp) updateTrack(trackId, { arp: defaultArp() }, 'Add Arp-Ape-ator');
  useUiStore.getState().set({ arpTrackId: trackId });
}

/** Switch the Arp-Ape-ator on / off (bypass: keys and clips play as they are). */
export function setArpEnabled(trackId: string, on: boolean): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t?.arp || t.arp.enabled === on) return;
  updateTrack(trackId, { arp: { ...t.arp, enabled: on } }, on ? 'Arp-Ape-ator on' : 'Arp-Ape-ator off');
}

/** Switch the Gucci Slipper-izer on / off (bypass: keys play single notes). */
export function setSlipperizerEnabled(trackId: string, on: boolean): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t?.chords || t.chords.enabled === on) return;
  updateTrack(trackId, { chords: { ...t.chords, enabled: on } }, on ? 'Slipper-izer on' : 'Slipper-izer off');
}

/** Create the Gucci Slipper-izer on a track (if needed) and open its window. */
export function openSlipperizer(trackId: string): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== 'instrument') return;
  if (!t.chords) updateTrack(trackId, { chords: defaultChordTool() }, 'Add Gucci Slipper-izer');
  useUiStore.getState().set({ chordsTrackId: trackId });
}
