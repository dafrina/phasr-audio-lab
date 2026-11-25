/**
 * Shared instrument-window keyboard: computer-key note input (layout
 * independent key codes), octave shift, latching sustain, pitch bend and
 * the on-screen keybed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { engine } from '../../audio/engine';
import { BendWheel, PianoKeyboard } from './PianoKeyboard';

/** Physical key codes → semitones above the base C. */
const KEY_MAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

export interface ComputerKeyboard {
  octave: number;
  setOctave: (fn: (o: number) => number) => void;
  sustain: boolean;
  toggleSustain: () => void;
  active: ReadonlySet<number>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onKeyUp: (e: React.KeyboardEvent) => void;
  /** release every computer-key note (window lost focus) */
  releaseAll: () => void;
}

export function useComputerKeyboard(trackId: string, onEscape: () => void, velocity = 0.8): ComputerKeyboard {
  const [octave, setOctaveState] = useState(4); // base C = C4 (MIDI 60)
  const [sustain, setSustain] = useState(false);
  const [active, setActive] = useState<ReadonlySet<number>>(new Set());
  const held = useRef(new Map<string, { note: number; id: number }>());

  useEffect(() => {
    const h = held.current;
    return () => {
      // never leave notes hanging when the window closes or switches track
      for (const x of h.values()) engine.previewNoteOff(trackId, x.id);
      h.clear();
      engine.sustain(trackId, false);
    };
  }, [trackId]);

  const refresh = () => setActive(new Set([...held.current.values()].map((h) => h.note)));
  const setOctave = useCallback((fn: (o: number) => number) => setOctaveState((o) => Math.min(8, Math.max(0, fn(o)))), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.preventDefault();
      setOctave((o) => o + (e.code === 'BracketRight' ? 1 : -1));
      return;
    }
    if (e.code === 'Escape') return onEscape();
    const off = KEY_MAP[e.code];
    if (off === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || held.current.has(e.code)) return;
    const note = (octave + 1) * 12 + off;
    if (note > 127) return;
    const id = engine.previewNoteOn(trackId, note, velocity);
    if (id === null) return;
    held.current.set(e.code, { note, id });
    refresh();
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const h = held.current.get(e.code);
    if (!h) return;
    engine.previewNoteOff(trackId, h.id);
    held.current.delete(e.code);
    refresh();
  };
  const releaseAll = () => {
    for (const h of held.current.values()) engine.previewNoteOff(trackId, h.id);
    held.current.clear();
    setActive(new Set());
  };
  const toggleSustain = () => {
    const on = !sustain;
    setSustain(on);
    engine.sustain(trackId, on);
  };
  return { octave, setOctave, sustain, toggleSustain, active, onKeyDown, onKeyUp, releaseAll };
}

export function KeyboardStrip({ trackId, kb, low = 36, high = 96, sustainLabel = 'Sustain' }: { trackId: string; kb: ComputerKeyboard; low?: number; high?: number; sustainLabel?: string }) {
  return (
    <div className="flex items-stretch gap-2 border-t border-line bg-panel-2 px-2 py-2">
      <div className="flex flex-col justify-between gap-1">
        <div className="flex items-center gap-1">
          <button type="button" title="Octave down ([)" onClick={() => kb.setOctave((o) => o - 1)} className="h-5 w-5 rounded bg-panel-3 text-[11px] hover:bg-line-2">
            −
          </button>
          <span className="w-10 text-center font-mono text-[10px] text-muted" title="Computer keyboard base octave">
            C{kb.octave}
          </span>
          <button type="button" title="Octave up (])" onClick={() => kb.setOctave((o) => o + 1)} className="h-5 w-5 rounded bg-panel-3 text-[11px] hover:bg-line-2">
            +
          </button>
        </div>
        <button
          type="button"
          title={`${sustainLabel} pedal (latching)`}
          onClick={kb.toggleSustain}
          className={`h-5 rounded px-1.5 text-[10px] uppercase tracking-wide ${kb.sustain ? 'bg-accent text-white' : 'bg-panel-3 text-muted'}`}
        >
          {sustainLabel}
        </button>
        <div className="max-w-[92px] text-[9px] leading-tight text-dim">Keys Z–M / Q–P play · [ ] octave</div>
      </div>
      <BendWheel onChange={(v) => engine.pitchBend(trackId, v)} />
      <div className="flex-1">
        <PianoKeyboard
          low={low}
          high={high}
          externalActive={kb.active}
          onNoteOn={(n, v) => engine.previewNoteOn(trackId, n, v)}
          onNoteOff={(_n, id) => engine.previewNoteOff(trackId, id)}
        />
      </div>
    </div>
  );
}
