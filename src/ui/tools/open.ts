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

/** Create the Gucci Slipper-izer on a track (if needed) and open its window. */
export function openSlipperizer(trackId: string): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== 'instrument') return;
  if (!t.chords) updateTrack(trackId, { chords: defaultChordTool() }, 'Add Gucci Slipper-izer');
  useUiStore.getState().set({ chordsTrackId: trackId });
}
