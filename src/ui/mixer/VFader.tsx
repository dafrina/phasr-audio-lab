import { useRef } from 'react';

const MIN_DB = -60;
const MAX_DB = 6;
const CURVE = 2.2;

/** Fader position (0..1) ↔ dB. A power curve gives fine resolution around 0 dB. */
export function dbToPos(db: number): number {
  const n = (Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB);
  return Math.pow(n, CURVE);
}

export function posToDb(pos: number): number {
  const n = Math.pow(Math.min(1, Math.max(0, pos)), 1 / CURVE);
  return MIN_DB + n * (MAX_DB - MIN_DB);
}

const MARKS = [6, 0, -6, -12, -24, -40, -60];

/**
 * Vertical channel fader. Drag (Shift = fine), wheel to step, double-click
 * for 0 dB, arrow keys when focused.
 */
export function VFader({ db, onChange, height, title }: { db: number; onChange: (db: number) => void; height: number; title: string }) {
  const drag = useRef<{ y: number; pos: number } | null>(null);
  const pos = dbToPos(db);
  const travel = height - 16;
  const set = (p: number) => {
    const v = Math.round(posToDb(p) * 10) / 10;
    onChange(v <= MIN_DB + 0.05 ? MIN_DB : v);
  };
  return (
    <div
      className="relative w-7 cursor-ns-resize outline-none"
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={title}
      aria-valuemin={MIN_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={db}
      title={`${title} — drag, Shift for fine, double-click for 0 dB`}
      onPointerDown={(e) => {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const sens = e.shiftKey ? 0.2 : 1;
        const np = d.pos + ((d.y - e.clientY) / travel) * sens;
        drag.current = { y: e.clientY, pos: Math.min(1, Math.max(0, np)) };
        set(np);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onChange(0)}
      onWheel={(e) => {
        e.stopPropagation();
        onChange(Math.min(MAX_DB, Math.max(MIN_DB, Math.round((db + (e.deltaY < 0 ? 0.5 : -0.5)) * 10) / 10)));
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          onChange(Math.min(MAX_DB, Math.max(MIN_DB, db + (e.key === 'ArrowUp' ? 0.5 : -0.5))));
        }
      }}
    >
      {/* scale */}
      {MARKS.map((m) => (
        <div key={m} className="pointer-events-none absolute left-0 w-1.5 bg-line-2" style={{ height: 1, bottom: 8 + dbToPos(m) * travel }} />
      ))}
      <div className="absolute bottom-2 left-1/2 top-2 w-[3px] -translate-x-1/2 rounded bg-base" />
      <div
        className="absolute left-1/2 h-4 w-6 -translate-x-1/2 rounded-[3px] border border-black/60 bg-gradient-to-b from-[#e8e8f2] to-[#a8a8bc] shadow"
        style={{ bottom: pos * travel }}
      >
        <div className="absolute left-1 right-1 top-1/2 h-px bg-black/50" />
      </div>
    </div>
  );
}
