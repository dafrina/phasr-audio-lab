/** UI-facing recording state. The recorder controller is the only writer. */
import { create } from 'zustand';

export type RecordStatus = 'idle' | 'opening' | 'ready' | 'countIn' | 'recording' | 'finishing';

export interface InputDevice {
  deviceId: string;
  label: string;
}

interface RecordingStore {
  status: RecordStatus;
  inputs: InputDevice[];
  deviceId: string;
  /** Track currently armed for recording */
  armedTrackId: string | null;
  /** Estimated round-trip latency in ms (auto part) */
  autoLatencyMs: number;
  /** User correction added on top of the estimate */
  manualOffsetMs: number;
  inputLabel: string | null;
  error: string | null;
}

const DEVICE_KEY = 'phasr.rec.device';
const OFFSET_KEY = 'phasr.rec.offsetMs';

function readLS(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLS(key: string, v: string): void {
  try {
    globalThis.localStorage?.setItem(key, v);
  } catch {
    // storage unavailable: preference just won't persist
  }
}

export const REC_KEYS = { DEVICE_KEY, OFFSET_KEY };

export const useRecordingStore = create<RecordingStore>(() => ({
  status: 'idle',
  inputs: [],
  deviceId: readLS(DEVICE_KEY) ?? '',
  armedTrackId: null,
  autoLatencyMs: 0,
  manualOffsetMs: Number(readLS(OFFSET_KEY) ?? 0) || 0,
  inputLabel: null,
  error: null,
}));
