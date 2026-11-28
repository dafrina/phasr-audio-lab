import { useRef, useState } from 'react';
import { fromNormalized, toNormalized, type NumericParamSpec } from '../../synth/params';

interface KnobProps {
  spec: NumericParamSpec;
  value: number;
  onChange: (v: number) => void;
  /** Called once when a drag gesture ends (used to close an undo step) */
  onCommitEnd?: () => void;
  label?: string;
  size?: number;
  disabled?: boolean;
  color?: string;
  title?: string;
}

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`;
}

/**
 * Rotary control. Drag vertically (Shift = fine), mouse wheel to step,
 * double-click to reset to default, arrow keys when focused.
 */
export function Knob({ spec, value, onChange, onCommitEnd, label, size = 34, disabled, color = 'var(--color-accent)', title }: KnobProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; n: number; id: number } | null>(null);
  const n = Math.min(1, Math.max(0, toNormalized(spec, value)));
  const angle = START + n * SWEEP;
  const zeroN = spec.bipolar ? toNormalized(spec, 0) : 0;
  const zeroAngle = START + Math.min(1, Math.max(0, zeroN)) * SWEEP;
  const r = size / 2 - 3;
  const c = size / 2;
  const [px, py] = polar(c, c, r - 4, angle);

  const setN = (nn: number) => {
    const v = fromNormalized(spec, nn);
    if (v !== value) onChange(v);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, n, id: e.pointerId };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    // (only the finger that grabbed it: another one on this knob doesn't take it over)
    if (!d || e.pointerId !== d.id) return;
    const sens = e.shiftKey ? 0.0012 : 0.006;
    const nn = Math.min(1, Math.max(0, d.n + (d.y - e.clientY) * sens));
    // re-anchor so switching Shift mid-drag doesn't jump
    drag.current = { y: e.clientY, n: nn, id: d.id };
    setN(nn);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current = null;
    setDragging(false);
    onCommitEnd?.();
  };
  const onWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    e.stopPropagation();
    const step = spec.step ? spec.step / (spec.max - spec.min) : e.shiftKey ? 0.002 : 0.02;
    setN(n + (e.deltaY < 0 ? step : -step));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const step = spec.step ? spec.step / (spec.max - spec.min) : e.shiftKey ? 0.002 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      setN(n + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      setN(n - step);
    }
  };

  const text = spec.format(value);
  return (
    <div
      className={`flex flex-col items-center gap-0.5 ${disabled ? 'opacity-35' : ''}`}
      title={title ?? `${label ?? spec.label}: ${text} — drag, Shift for fine, double-click to reset`}
    >
      <div className="relative">
        <svg
          width={size}
          height={size}
          tabIndex={disabled ? -1 : 0}
          role="slider"
          aria-label={label ?? spec.label}
          aria-valuemin={spec.min}
          aria-valuemax={spec.max}
          aria-valuenow={value}
          aria-valuetext={text}
          className={`touch-control outline-none ${disabled ? '' : 'cursor-ns-resize'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => !disabled && onChange(spec.default)}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        >
          <circle cx={c} cy={c} r={r - 2} fill="#1b1b29" stroke="#00000080" />
          <path d={arc(c, c, r, START, START + SWEEP)} stroke="#2c2c40" strokeWidth={3} fill="none" strokeLinecap="round" />
          {Math.abs(angle - zeroAngle) > 0.5 && (
            <path
              d={arc(c, c, r, Math.min(zeroAngle, angle), Math.max(zeroAngle, angle))}
              stroke={color}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
            />
          )}
          <line x1={c} y1={c} x2={px} y2={py} stroke="#e8e8f2" strokeWidth={2} strokeLinecap="round" />
        </svg>
        {/* a finger's area: a little larger than the knob (touch screens only; a mouse never sees it) */}
        {!disabled && (
          <span
            aria-hidden
            className="touch-hit"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => onChange(spec.default)}
          />
        )}
        {dragging && (
          <div className="pointer-events-none absolute -top-5 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 font-mono text-[10px] text-fg">
            {text}
          </div>
        )}
      </div>
      <div className="max-w-[56px] truncate text-[9px] uppercase tracking-wide text-muted">{label ?? spec.label}</div>
    </div>
  );
}
