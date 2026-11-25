/**
 * Web MIDI input. Incoming notes are routed to the track whose TriOsc window is
 * open, otherwise to the selected instrument track. Each note-off is sent to
 * the track that received the matching note-on, so switching tracks while a
 * key is held can't leave a note stuck.
 */
import { getProject } from '../state/projectStore';
import { useUiStore } from '../state/uiStore';
import { engine } from './engine';

type Listener = (s: MidiStatus) => void;

export interface MidiStatus {
  supported: boolean;
  enabled: boolean;
  inputs: string[];
  error: string | null;
}

/** Parse a raw MIDI message into a typed event (pure; unit tested). */
export type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number }
  | { type: 'sustain'; channel: number; on: boolean }
  | { type: 'bend'; channel: number; value: number }
  | { type: 'allNotesOff'; channel: number }
  | null;

export function parseMidi(data: ArrayLike<number>): MidiEvent {
  const status = data[0] ?? 0;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;
  switch (kind) {
    case 0x90:
      return d2 > 0 ? { type: 'noteOn', channel, note: d1, velocity: d2 / 127 } : { type: 'noteOff', channel, note: d1 };
    case 0x80:
      return { type: 'noteOff', channel, note: d1 };
    case 0xb0:
      if (d1 === 64) return { type: 'sustain', channel, on: d2 >= 64 };
      if (d1 === 120 || d1 === 123) return { type: 'allNotesOff', channel };
      return null;
    case 0xe0: {
      const raw = (d2 << 7) | d1;
      return { type: 'bend', channel, value: Math.max(-1, (raw - 8192) / 8191) };
    }
    default:
      return null;
  }
}

class WebMidiInput {
  private access: MIDIAccess | null = null;
  private status: MidiStatus = {
    supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    enabled: false,
    inputs: [],
    error: null,
  };
  private listeners = new Set<Listener>();
  private held = new Map<number, { trackId: string; id: number }>();
  private sustainTracks = new Set<string>();

  getStatus(): MidiStatus {
    return this.status;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<MidiStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  async enable(): Promise<void> {
    if (!this.status.supported) {
      this.emit({ error: 'Web MIDI is not supported in this browser.' });
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.emit({ enabled: false, error: `MIDI access was denied (${e instanceof Error ? e.message : 'unknown error'}).` });
      return;
    }
    this.access.onstatechange = () => this.attach();
    this.attach();
    this.emit({ enabled: true, error: null });
  }

  disable(): void {
    if (this.access) {
      for (const input of this.access.inputs.values()) input.onmidimessage = null;
      this.access.onstatechange = null;
    }
    this.access = null;
    this.releaseAll();
    this.emit({ enabled: false, inputs: [] });
  }

  private attach(): void {
    if (!this.access) return;
    const names: string[] = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== 'connected') continue;
      names.push(input.name ?? 'MIDI input');
      input.onmidimessage = (e) => {
        if (e.data) this.handle(e.data);
      };
    }
    // a device was unplugged: release anything it was holding
    if (names.length < this.status.inputs.length) this.releaseAll();
    this.emit({ inputs: names });
  }

  private target(): string | null {
    const ui = useUiStore.getState();
    const p = getProject();
    const isInst = (id: string | null) => !!id && p.tracks.some((t) => t.id === id && t.kind === 'instrument');
    if (isInst(ui.synthTrackId)) return ui.synthTrackId;
    if (isInst(ui.selectedTrackId)) return ui.selectedTrackId;
    return p.tracks.find((t) => t.kind === 'instrument')?.id ?? null;
  }

  private handle(data: Uint8Array): void {
    const ev = parseMidi(data);
    if (!ev) return;
    const key = ev.channel * 128 + ('note' in ev ? ev.note : 0);
    if (ev.type === 'noteOn') {
      const prev = this.held.get(key);
      if (prev) engine.previewNoteOff(prev.trackId, prev.id);
      const trackId = this.target();
      if (!trackId) return;
      const id = engine.previewNoteOn(trackId, ev.note, ev.velocity);
      if (id !== null) this.held.set(key, { trackId, id });
    } else if (ev.type === 'noteOff') {
      const h = this.held.get(key);
      if (h) {
        engine.previewNoteOff(h.trackId, h.id);
        this.held.delete(key);
      }
    } else if (ev.type === 'sustain') {
      const trackId = this.target();
      if (!trackId) return;
      engine.sustain(trackId, ev.on);
      if (ev.on) this.sustainTracks.add(trackId);
      else this.sustainTracks.delete(trackId);
    } else if (ev.type === 'bend') {
      const trackId = this.target();
      if (trackId) engine.pitchBend(trackId, ev.value);
    } else if (ev.type === 'allNotesOff') {
      this.releaseAll();
    }
  }

  private releaseAll(): void {
    for (const h of this.held.values()) engine.previewNoteOff(h.trackId, h.id);
    this.held.clear();
    for (const t of this.sustainTracks) engine.sustain(t, false);
    this.sustainTracks.clear();
  }
}

export const midiInput = new WebMidiInput();
