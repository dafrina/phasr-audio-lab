import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Plus, type LucideIcon } from 'lucide-react';
import { INSTRUMENT_TYPES, INSTRUMENTS, type InstrumentType } from '../../instruments/definitions';
import { MAX_TRACKS } from '../../project/types';
import { addNewTrack } from '../actions';
import { INSTRUMENT_UI } from '../instruments';

/** How each track type is offered: accent colour and a one-line "what is it". */
const OFFER: Record<InstrumentType | 'audio', { color: string; blurb: string; order: number }> = {
  keys: { color: '#e8c37a', blurb: 'Piano, electric piano, organ, synths, 808', order: 0 },
  triosc: { color: '#a78bfa', blurb: 'Three-oscillator subtractive synth', order: 1 },
  drumrack: { color: '#fb923c', blurb: '16 pads, kits, styles and a step grid', order: 2 },
  sampler: { color: '#38bdf8', blurb: 'Your own samples mapped to the keys', order: 3 },
  audio: { color: '#4ade80', blurb: 'Record a microphone or import audio files', order: 4 },
};

const W = 280;

/**
 * "Add a track" under the last track header: a single + that opens a list of
 * track types (big icons, what each one is). Pick one, or Esc / click away.
 */
export function AddTrackRow({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const full = count >= MAX_TRACKS;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const toggle = () => {
    if (full) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      // below the +, kept on screen (opens upwards near the bottom)
      const h = 5 * 50 + 40;
      const y = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
      // centred under the +, kept on screen
      setAt({ x: Math.max(8, Math.min(window.innerWidth - W - 8, r.left + r.width / 2 - W / 2)), y });
    }
    setOpen((o) => !o);
  };
  const pick = (type: InstrumentType | 'audio') => {
    setOpen(false);
    addNewTrack(type);
  };

  const types: (InstrumentType | 'audio')[] = [...[...INSTRUMENT_TYPES].sort((a, b) => OFFER[a].order - OFFER[b].order), 'audio'];
  const item = (type: InstrumentType | 'audio') => {
    const Icon: LucideIcon = type === 'audio' ? AudioLines : INSTRUMENT_UI[type].icon;
    const label = type === 'audio' ? 'Audio' : INSTRUMENTS[type].label;
    const { color, blurb } = OFFER[type];
    return (
      <button
        key={type}
        type="button"
        role="menuitem"
        aria-label={label}
        title={type === 'audio' ? 'Add an audio track (for recording and audio clips)' : `Add a ${label} track — ${INSTRUMENTS[type].description}`}
        onClick={() => pick(type)}
        className="group flex h-[48px] w-full items-center gap-3 rounded-md border border-transparent px-2 text-left hover:bg-panel-3"
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = color)}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'transparent')}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}22`, color }}>
          <Icon size={22} />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[12px] font-semibold text-fg">{label}</span>
          <span className="truncate text-[10px] text-dim group-hover:text-muted">{blurb}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex justify-center pb-8 pt-12">
      <button
        ref={btn}
        type="button"
        aria-label="Add a track"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={full}
        title={full ? `All ${MAX_TRACKS} tracks are in use — delete one to add another` : 'Add a track'}
        onClick={toggle}
        className={`flex h-10 w-10 items-center justify-center rounded-lg border border-dashed text-muted transition-colors ${open ? 'border-accent bg-panel-3 text-fg' : 'border-line-2 hover:border-accent hover:bg-panel-2 hover:text-fg'} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Plus size={20} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} role="menu" className="fixed z-[60] flex flex-col gap-0.5 rounded-lg border border-line-2 bg-panel p-1.5 shadow-2xl shadow-black/70" style={{ left: at.x, top: at.y, width: W }}>
            <div className="flex items-center px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Add a track
              <span className="ml-auto font-mono font-normal normal-case tracking-normal text-dim">
                {count} / {MAX_TRACKS}
              </span>
            </div>
            {types.map(item)}
          </div>,
          document.body,
        )}
    </div>
  );
}
