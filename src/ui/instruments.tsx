/**
 * Instrument registry — UI part: icon and editor window per instrument type.
 * (See instruments/definitions.ts for how to add a new instrument.)
 */
import { Suspense, lazy, type ComponentType } from 'react';
import { AudioWaveform, Drum, Piano, Waves, type LucideIcon } from 'lucide-react';
import type { InstrumentType } from '../instruments/definitions';
import { useProjectStore } from '../state/projectStore';

// the editor windows load on demand (their code isn't needed until one opens; see preloadWindows)
const SynthWindow = lazy(() => import('./synth/SynthWindow').then((m) => ({ default: m.SynthWindow })));
const DrumRackWindow = lazy(() => import('./drums/DrumRackWindow').then((m) => ({ default: m.DrumRackWindow })));
const KeysWindow = lazy(() => import('./keys/KeysWindow').then((m) => ({ default: m.KeysWindow })));
const SamplerWindow = lazy(() => import('./sampler/SamplerWindow').then((m) => ({ default: m.SamplerWindow })));
export const ArpWindow = lazy(() => import('./arp/ArpWindow').then((m) => ({ default: m.ArpWindow })));
export const SlipperizerWindow = lazy(() => import('./chords/SlipperizerWindow').then((m) => ({ default: m.SlipperizerWindow })));
export const AnalyzerWindow = lazy(() => import('./analyzer/AnalyzerWindow').then((m) => ({ default: m.AnalyzerWindow })));

/** Fetch the windows' code in the background once the app is up, so the first open is instant. */
export function preloadWindows(): void {
  const load = () => {
    void import('./synth/SynthWindow');
    void import('./drums/DrumRackWindow');
    void import('./keys/KeysWindow');
    void import('./sampler/SamplerWindow');
    void import('./arp/ArpWindow');
    void import('./chords/SlipperizerWindow');
    void import('./analyzer/AnalyzerWindow');
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 4000 });
  else setTimeout(load, 1500);
}

export const INSTRUMENT_UI: { [T in InstrumentType]: { icon: LucideIcon; Editor: ComponentType<{ trackId: string }> } } = {
  triosc: { icon: Waves, Editor: SynthWindow },
  drumrack: { icon: Drum, Editor: DrumRackWindow },
  keys: { icon: Piano, Editor: KeysWindow },
  sampler: { icon: AudioWaveform, Editor: SamplerWindow },
};

/** Opens the editor window that matches the track's instrument type. */
export function InstrumentEditor({ trackId }: { trackId: string }) {
  const type = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId)?.instrument?.type);
  if (!type) return null;
  const { Editor } = INSTRUMENT_UI[type];
  return (
    <Suspense fallback={null}>
      <Editor trackId={trackId} />
    </Suspense>
  );
}
