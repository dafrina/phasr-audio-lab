/**
 * Shared instrument-window keyboard: computer-key note input (layout
 * independent key codes), octave shift, latching sustain, pitch bend and
 * the on-screen keybed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { engine } from '../../audio/engine';
import { BendWheel, PianoKeyboard } from './PianoKeyboard';
import { useLiveKeys } from '../liveKeys';
import { instrumentAutoParams } from '../../instruments/definitions';
import type { AutomationTarget } from '../../project/types';
import { automate, deleteLane, setLaneEnabled, showLane } from '../../state/automationActions';
import { useProjectStore } from '../../state/projectStore';
import { PITCH_BEND_KEY } from '../../synth/dsp/bend';
import { useAutomatedValue } from '../common/AutoKnob';
import { ContextMenu, type MenuItem } from '../common/ContextMenu';

const BEND_TARGET: AutomationTarget = { kind: 'inst', param: PITCH_BEND_KEY };

/** The pitch wheel, with the same right-click automation menu as the knobs. */
function AutomatableBendWheel({ trackId }: { trackId: string }) {
  const can = useProjectStore((s) => instrumentAutoParams(s.project.tracks.find((t) => t.id === trackId)?.instrument ?? null).some((p) => p.key === PITCH_BEND_KEY));
  const auto = useAutomatedValue(trackId, BEND_TARGET, 0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const items: MenuItem[] = auto.laneId
    ? [
        { label: 'Show automation lane', onClick: () => auto.laneId && (showLane(trackId, auto.laneId), automate(trackId, BEND_TARGET)) },
        { label: auto.enabled ? 'Disable automation' : 'Enable automation', onClick: () => auto.laneId && setLaneEnabled(trackId, auto.laneId, !auto.enabled) },
        { label: 'Delete automation', danger: true, onClick: () => auto.laneId && deleteLane(trackId, auto.laneId) },
      ]
    : [{ label: 'Automate pitch bend', onClick: () => automate(trackId, BEND_TARGET) }];
  return (
    <div
      className="relative flex flex-col items-center gap-1"
      title={can ? `Pitch bend — drag up/down, springs back to center${auto.automated ? ' · automated' : ''} · right-click to automate` : undefined}
      onContextMenu={(e) => {
        if (!can) return;
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <BendWheel height={50} onChange={(v) => engine.pitchBend(trackId, v)} />
      <span className="text-[8px] font-semibold uppercase leading-none tracking-[0.14em] text-muted">Pitch</span>
      {auto.laneId && <span className={`pointer-events-none absolute -right-1 -top-1 h-2 w-2 rounded-full ${auto.enabled ? 'bg-[#f472b6]' : 'bg-dim'}`} title="Automated" />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Physical key codes → semitones above the base C. */
export const KEY_MAP: Record<string, number> = {
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
  /** release every computer-key note */
  releaseAll: () => void;
}

/** `windowId`: the window's windowStack id, so the keys follow the window in front */
export function useComputerKeyboard(trackId: string, onEscape: () => void, velocity = 0.8, windowId?: string): ComputerKeyboard {
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

  // the window owns the computer keyboard while it is open, wherever the focus is (see liveKeys)
  const keyDown = (e: KeyboardEvent): boolean => {
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      setOctave((o) => o + (e.code === 'BracketRight' ? 1 : -1));
      return true;
    }
    if (e.code === 'Escape') {
      onEscape();
      return true;
    }
    const off = KEY_MAP[e.code];
    if (off === undefined) return false;
    if (e.repeat || held.current.has(e.code)) return true;
    const note = (octave + 1) * 12 + off;
    if (note > 127) return true;
    const id = engine.previewNoteOn(trackId, note, velocity);
    if (id === null) return true;
    held.current.set(e.code, { note, id });
    refresh();
    return true;
  };
  const keyUp = (e: KeyboardEvent): boolean => {
    const h = held.current.get(e.code);
    if (!h) return false;
    engine.previewNoteOff(trackId, h.id);
    held.current.delete(e.code);
    refresh();
    return true;
  };
  const releaseAll = () => {
    // Nothing held → no state change. (Re-rendering here, on blur, used to reset a native
    // dropdown to its old value just before the browser delivered the new selection.)
    if (!held.current.size) return;
    for (const h of held.current.values()) engine.previewNoteOff(trackId, h.id);
    held.current.clear();
    setActive(new Set());
  };
  const toggleSustain = () => {
    const on = !sustain;
    setSustain(on);
    engine.sustain(trackId, on);
  };
  useLiveKeys({ keyDown, keyUp, release: releaseAll }, windowId);
  return { octave, setOctave, sustain, toggleSustain, active, releaseAll };
}

/** a raised, hardware-style button (the strip's octave and sustain buttons) */
const HW_BUTTON =
  'touch-btn flex items-center justify-center rounded-md border border-black/70 bg-gradient-to-b from-[#3c3c57] to-[#20202f] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_2px_3px_rgba(0,0,0,0.55)] transition-[transform,box-shadow] hover:from-[#46466a] active:translate-y-px active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)] disabled:cursor-not-allowed disabled:opacity-35';

export function KeyboardStrip({ trackId, kb, low = 36, high = 96, sustainLabel = 'Sustain', flashColor }: { trackId: string; kb: ComputerKeyboard; low?: number; high?: number; sustainLabel?: string; flashColor?: string }) {
  // the on-screen keys follow the octave selector too (− / +, [ ]): at C4 they span low…high, each octave up or
  // down moves them by 12 — as many keys as ever, kept within MIDI's 0–127
  const width = high - low;
  const lo = Math.max(0, Math.min(127 - width, low + (kb.octave - 4) * 12));
  return (
    <div className="flex items-stretch gap-2 border-t border-line bg-panel-2 px-2 py-2">
      {/* (the octave row sets this column's width: Sustain matches it, the hint wraps within it) */}
      <div className="flex flex-col justify-between gap-1.5">
        <div className="flex items-center gap-1" role="group" aria-label="Octave">
          <button type="button" title="Octave down ([)" aria-label="Octave down" disabled={kb.octave <= 0} onClick={() => kb.setOctave((o) => o - 1)} className={`${HW_BUTTON} h-7 w-7`}>
            <ChevronDown size={15} strokeWidth={2.6} />
          </button>
          <div className="flex h-7 w-[44px] flex-col items-center justify-center rounded-md border border-black/80 bg-[#06060b] shadow-[inset_0_1px_4px_rgba(0,0,0,0.9)]">
            <span className="font-mono text-[13px] font-bold leading-none text-accent-hi" title="Octave: the computer keys (Z = this C) and the on-screen keys move with it">
              C{kb.octave}
            </span>
            <span className="mt-0.5 text-[7px] font-semibold uppercase leading-none tracking-[0.16em] text-dim">Octave</span>
          </div>
          <button type="button" title="Octave up (])" aria-label="Octave up" disabled={kb.octave >= 8} onClick={() => kb.setOctave((o) => o + 1)} className={`${HW_BUTTON} h-7 w-7`}>
            <ChevronUp size={15} strokeWidth={2.6} />
          </button>
        </div>
        <button
          type="button"
          title={`${sustainLabel} pedal (latching)`}
          aria-pressed={kb.sustain}
          onClick={kb.toggleSustain}
          className={`${HW_BUTTON} h-6 px-2 text-[10px] font-semibold uppercase tracking-wide ${kb.sustain ? '!border-accent !from-accent-hi !to-accent text-white shadow-[0_0_8px_rgba(118,93,252,0.6)]' : 'text-muted'}`}
        >
          {sustainLabel}
        </button>
        <div className="w-0 min-w-full text-[9px] leading-tight text-dim" title="While this window is open the computer keyboard plays it, wherever you clicked last. Space still plays/stops the song.">Keys Z–M / Q–P play · [ ] octave</div>
      </div>
      <AutomatableBendWheel trackId={trackId} />
      <div className="flex-1">
        <PianoKeyboard
          low={lo}
          high={lo + width}
          externalActive={kb.active}
          flashColor={flashColor}
          onNoteOn={(n, v) => engine.previewNoteOn(trackId, n, v)}
          onNoteOff={(_n, id) => engine.previewNoteOff(trackId, id)}
        />
      </div>
    </div>
  );
}
