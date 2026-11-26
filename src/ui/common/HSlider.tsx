import { useRef } from 'react';

/** Shift slows a drag to a fifth of its speed, as on the knobs and mixer faders. */
export const FINE = 0.2;
const THUMB = 10;

interface HSliderProps {
  value: number;
  min: number;
  max: number;
  /** values are rounded to this; arrow keys move 5 steps (Shift: 1) */
  step: number;
  onChange: (v: number) => void;
  /** a drag begins (open an undo / automation gesture) */
  onStart?: () => void;
  /** the drag ended */
  onEnd?: () => void;
  onDoubleClick?: () => void;
  label: string;
  title?: string;
  className?: string;
}

/**
 * Horizontal slider. Click the track to jump there, drag to move (Shift = fine,
 * and Shift-click doesn't jump, so a fine drag starts from the current value),
 * arrow keys when focused (Shift = fine).
 */
export function HSlider({ value, min, max, step, onChange, onStart, onEnd, onDoubleClick, label, title, className = '' }: HSliderProps) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; v: number } | null>(null);
  const span = max - min;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const n = span > 0 ? (clamp(value) - min) / span : 0;
  const emit = (v: number) => {
    const r = clamp(Math.round(v / step) * step);
    const out = Number(r.toFixed(10));
    if (out !== value) onChange(out);
  };
  const travel = () => Math.max(1, (el.current?.getBoundingClientRect().width ?? 100) - THUMB);

  return (
    <div
      ref={el}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={title}
      className={`relative h-[14px] cursor-ew-resize outline-none ${className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        onStart?.();
        const r = e.currentTarget.getBoundingClientRect();
        const thumbX = r.left + THUMB / 2 + n * (r.width - THUMB);
        let v = value;
        // a click beside the thumb jumps there (not with Shift: fine-tune from where it is)
        if (!e.shiftKey && Math.abs(e.clientX - thumbX) > THUMB / 2 + 2) {
          v = clamp(min + ((e.clientX - r.left - THUMB / 2) / Math.max(1, r.width - THUMB)) * span);
          emit(v);
        }
        drag.current = { x: e.clientX, v };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // relative, re-anchored every move so pressing or releasing Shift mid-drag doesn't jump
        const v = clamp(d.v + ((e.clientX - d.x) / travel()) * span * (e.shiftKey ? FINE : 1));
        drag.current = { x: e.clientX, v };
        emit(v);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        onEnd?.();
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = null;
        onEnd?.();
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopPropagation();
        emit(value + dir * step * (e.shiftKey ? 1 : 5));
      }}
    >
      <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-[2px] bg-line-2" />
      <div
        className="pointer-events-none absolute top-px h-3 rounded-[2px] border border-black/40 bg-[#d8d8e6]"
        style={{ width: THUMB, left: `calc(${n} * (100% - ${THUMB}px))` }}
      />
    </div>
  );
}
