import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useUiStore } from '../../state/uiStore';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Transport & project',
    items: [
      ['Space', 'Play / stop (also right after using a dropdown)'],
      ['Enter', 'Stop (again: back to bar 1)'],
      ['R', 'Record on the armed audio track'],
      ['L', 'Loop on / off'],
      ['M', 'Metronome on / off'],
      ['Ctrl+S', 'Save now (autosave is always on)'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
      ['F9', 'Mixer'],
      ['A', 'Automation mode (draw automation on tracks)'],
      ['?', 'This help'],
    ],
  },
  {
    title: 'Arrangement',
    items: [
      ['Click / drag clip', 'Select / move (Shift: no snap, Alt: duplicate)'],
      ['Drag clip edge', 'Trim'],
      ['Ctrl/Shift-drag empty', 'Box-select clips'],
      ['Drag empty', 'Time selection (L or right-click → set loop)'],
      ['Double-click', 'Open clip / create MIDI clip on instrument tracks'],
      ['Ctrl+A', 'Select all clips'],
      ['← → (Alt: 1 tick)', 'Nudge selected clips by the grid'],
      ['↑ ↓', 'Move selected clips to the next track'],
      ['S', 'Split at playhead'],
      ['Ctrl+D / Ctrl+C / Ctrl+V', 'Duplicate / copy / paste'],
      ['Ctrl+L', 'Loop clip content'],
      ['Delete', 'Delete selected clips'],
      ['Ctrl+wheel / Shift+wheel', 'Zoom / scroll horizontally'],
    ],
  },
  {
    title: 'Piano roll',
    items: [
      ['Click / drag', 'Add / move notes; drag right edge to resize'],
      ['Right-click', 'Delete notes'],
      ['Ctrl/Shift-drag', 'Select notes'],
      ['Space+drag, middle-drag', 'Pan'],
      ['↑ ↓ (Shift: octave)', 'Transpose'],
      ['← →', 'Nudge'],
      ['Q', 'Quantize'],
      ['Ctrl+A / C / X / V / D', 'Select all / copy / cut / paste / duplicate'],
    ],
  },
  {
    title: 'Instruments & knobs',
    items: [
      ['Z–M / Q–P', 'Play TriOsc ([ ] octave)'],
      ['Z–V / A–F / Q–R / 1–4', 'Play drum pads'],
      ['Drag knob (Shift: fine)', 'Change value; double-click resets'],
      ['Right-click knob', 'Automate / sidechain'],
    ],
  },
];

export function ShortcutHelp() {
  const open = useUiStore((s) => s.helpOpen);
  const set = useUiStore((s) => s.set);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && set({ helpOpen: false });
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, set]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55" onPointerDown={(e) => e.target === e.currentTarget && set({ helpOpen: false })}>
      <div className="max-h-[85vh] w-[860px] overflow-y-auto rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70">
        <div className="flex h-10 items-center border-b border-line bg-panel-2 px-3">
          <span className="text-[13px] font-semibold text-fg">Keyboard &amp; mouse</span>
          <button type="button" onClick={() => set({ helpOpen: false })} className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg" title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4 p-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{g.title}</div>
              {g.items.map(([k, d]) => (
                <div key={k} className="flex gap-3 border-b border-line/50 py-1 text-[11px]">
                  <span className="w-[150px] shrink-0 font-mono text-accent-hi">{k}</span>
                  <span className="text-fg">{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
