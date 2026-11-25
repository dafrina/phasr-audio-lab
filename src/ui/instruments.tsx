/**
 * Instrument registry — UI part: icon and editor window per instrument type.
 * (See instruments/definitions.ts for how to add a new instrument.)
 */
import type { ComponentType } from 'react';
import { Drum, Waves, type LucideIcon } from 'lucide-react';
import type { InstrumentType } from '../instruments/definitions';
import { useProjectStore } from '../state/projectStore';
import { DrumRackWindow } from './drums/DrumRackWindow';
import { SynthWindow } from './synth/SynthWindow';

export const INSTRUMENT_UI: { [T in InstrumentType]: { icon: LucideIcon; Editor: ComponentType<{ trackId: string }> } } = {
  triosc: { icon: Waves, Editor: SynthWindow },
  drumrack: { icon: Drum, Editor: DrumRackWindow },
};

/** Opens the editor window that matches the track's instrument type. */
export function InstrumentEditor({ trackId }: { trackId: string }) {
  const type = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId)?.instrument?.type);
  if (!type) return null;
  const { Editor } = INSTRUMENT_UI[type];
  return <Editor trackId={trackId} />;
}
