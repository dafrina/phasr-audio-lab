import { useEffect, useRef, useState } from 'react';
import { isBlackKey, midiNoteName } from '../../core/time';

interface PianoKeyboardProps {
  low: number;
  high: number;
  /** returns a note-instance id used for the matching note-off */
  onNoteOn: (note: number, velocity: number) => number | null;
  onNoteOff: (note: number, id: number) => void;
  /** notes held from elsewhere (computer keyboard) to highlight */
  externalActive?: ReadonlySet<number>;
  height?: number;
  /** give every key a hidden overlay of this colour (`[data-note=n] > [data-flash]`) for flashing it from outside */
  flashColor?: string;
}

/**
 * Horizontal piano keyboard. Click/drag to play (glissando while dragging);
 * vertical click position on the key sets velocity (lower = louder).
 */
export function PianoKeyboard({ low, high, onNoteOn, onNoteOff, externalActive, height = 64, flashColor }: PianoKeyboardProps) {
  const [active, setActive] = useState<ReadonlySet<number>>(new Set());
  const held = useRef<{ note: number; id: number } | null>(null);
  const pointerDown = useRef(false);

  const whites: number[] = [];
  for (let n = low; n <= high; n++) if (!isBlackKey(n)) whites.push(n);
  const whiteW = 100 / whites.length;

  const release = () => {
    const h = held.current;
    if (h) {
      onNoteOff(h.note, h.id);
      held.current = null;
      setActive(new Set());
    }
  };

  const press = (note: number, e: React.PointerEvent) => {
    if (held.current?.note === note) return;
    release();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rel = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const velocity = 0.35 + 0.65 * rel;
    const id = onNoteOn(note, velocity);
    if (id !== null) {
      held.current = { note, id };
      setActive(new Set([note]));
    }
  };

  useEffect(() => {
    const up = () => {
      pointerDown.current = false;
      release();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('blur', up);
    };
  });

  const flash = flashColor ? <span data-flash className="pointer-events-none absolute inset-0 rounded-b-[3px]" style={{ background: flashColor, opacity: 0, boxShadow: `0 0 10px ${flashColor}` }} /> : null;
  const isOn = (n: number) => active.has(n) || (externalActive?.has(n) ?? false);
  const keyHandlers = (n: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      pointerDown.current = true;
      // release capture so pointerenter fires on other keys for glissando
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      press(n, e);
    },
    onPointerEnter: (e: React.PointerEvent) => {
      if (pointerDown.current) press(n, e);
    },
  });

  return (
    <div className="relative w-full select-none" style={{ height }} onPointerLeave={() => pointerDown.current && release()}>
      {whites.map((n, i) => (
        <div
          key={n}
          data-note={n}
          {...keyHandlers(n)}
          className={`absolute top-0 h-full rounded-b-[3px] border border-[#0a0a10] ${isOn(n) ? 'bg-accent-hi' : 'bg-[#e9e9f2] hover:bg-white'}`}
          style={{ left: `${i * whiteW}%`, width: `${whiteW}%` }}
          title={midiNoteName(n)}
        >
          {flash}
          {n % 12 === 0 && <span className="pointer-events-none absolute bottom-0.5 left-0 right-0 text-center text-[8px] text-[#555]">{midiNoteName(n)}</span>}
        </div>
      ))}
      {whites.map((n, i) => {
        const b = n + 1;
        if (b > high || !isBlackKey(b)) return null;
        return (
          <div
            key={b}
            data-note={b}
            {...keyHandlers(b)}
            className={`absolute top-0 z-10 rounded-b-[3px] border border-black ${isOn(b) ? 'bg-accent' : 'bg-[#1a1a24] hover:bg-[#2a2a38]'}`}
            style={{ left: `${(i + 1) * whiteW - whiteW * 0.32}%`, width: `${whiteW * 0.64}%`, height: '60%' }}
            title={midiNoteName(b)}
          >
            {flash}
          </div>
        );
      })}
    </div>
  );
}

/** Spring-loaded pitch-bend wheel: drag vertically, returns to center on release. */
export function BendWheel({ onChange, height = 64 }: { onChange: (v: number) => void; height?: number }) {
  const [v, setV] = useState(0);
  const start = useRef<{ y: number } | null>(null);
  const set = (nv: number) => {
    setV(nv);
    onChange(nv);
  };
  return (
    <div
      title="Pitch bend — drag up/down, springs back to center"
      className="relative w-4 cursor-ns-resize rounded bg-base"
      style={{ height }}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        start.current = { y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        set(Math.max(-1, Math.min(1, (start.current.y - e.clientY) / (height / 2))));
      }}
      onPointerUp={() => {
        start.current = null;
        set(0);
      }}
      onPointerCancel={() => {
        start.current = null;
        set(0);
      }}
    >
      <div className="absolute left-0 right-0 top-1/2 h-px bg-line-2" />
      <div
        className="absolute left-0.5 right-0.5 h-2 rounded-sm bg-fg"
        style={{ top: `calc(${50 - v * 45}% - 4px)` }}
      />
    </div>
  );
}
