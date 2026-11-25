/** Mirrors coarse transport state for React (position is read per frame, not stored). */
import { create } from 'zustand';
import type { TransportState } from '../audio/transport';
import type { EngineStatus } from '../audio/engine';

interface TransportStore {
  state: TransportState;
  countingIn: boolean;
  engineStatus: EngineStatus;
  engineError: string | null;
  contextRunning: boolean;
}

export const useTransportStore = create<TransportStore>(() => ({
  state: 'stopped',
  countingIn: false,
  engineStatus: 'idle',
  engineError: null,
  contextRunning: false,
}));
