/** Ephemeral UI state (selection, zoom, panels). Never saved with the project. */
import { create } from 'zustand';
import type { SnapValue } from '../core/time';

export type BottomPanel = 'none' | 'editor' | 'mixer' | 'track';

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

interface UiState {
  selectedClipIds: string[];
  selectedTrackId: string | null;
  snap: SnapValue;
  /** Piano roll has its own grid (finer by default than the arrangement's) */
  pianoSnap: SnapValue;
  /** Horizontal zoom in pixels per quarter note */
  pxPerBeat: number;
  scrollX: number;
  scrollY: number;
  /** Track whose TriOsc window is open */
  synthTrackId: string | null;
  bottomPanel: BottomPanel;
  bottomHeight: number;
  /** Clip open in the bottom editor */
  editorClipId: string | null;
  /** Track shown in the bottom "track devices" panel */
  fxTrackId: string | null;
  /** Automation editing mode: clicks on a track with a shown lane edit points instead of clips */
  automationMode: boolean;
  /** Which automation lane is drawn over each track (trackId → laneId) */
  shownLanes: Record<string, string | null>;
  /** Selected Spectra EQ band per effect slot (slotId → band index) */
  peqSelected: Record<string, number>;
  audioReady: boolean;
  toasts: Toast[];
  set: (s: Partial<Omit<UiState, 'set' | 'toast' | 'dismissToast'>>) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
}

let toastId = 1;

export const useUiStore = create<UiState>((set) => ({
  selectedClipIds: [],
  selectedTrackId: null,
  snap: '1/4',
  pianoSnap: '1/16',
  pxPerBeat: 40,
  scrollX: 0,
  scrollY: 0,
  synthTrackId: null,
  bottomPanel: 'none',
  bottomHeight: 300,
  editorClipId: null,
  fxTrackId: null,
  automationMode: false,
  shownLanes: {},
  peqSelected: {},
  audioReady: false,
  toasts: [],
  set: (s) => set(s),
  toast: (kind, message) => {
    const id = toastId++;
    set((st) => ({ toasts: [...st.toasts, { id, kind, message }] }));
    setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export function openTrackDevices(trackId: string): void {
  useUiStore.getState().set({ fxTrackId: trackId, selectedTrackId: trackId, bottomPanel: 'track' });
}

export function toggleMixer(): void {
  const s = useUiStore.getState();
  s.set({ bottomPanel: s.bottomPanel === 'mixer' ? 'none' : 'mixer' });
}

export const uiToast = (kind: Toast['kind'], message: string) => useUiStore.getState().toast(kind, message);
