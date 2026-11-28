import { useEffect, useRef, useState } from 'react';
import { LONG_PRESS_MS, TOUCH_SLOP_PX } from '../touch';

/**
 * Tooltips for fingers: there's no hover on a touch screen, so a finger resting
 * on anything with a tooltip (a title) for a moment shows it above the finger
 * until it lifts — and that press then doesn't also click. Elements with their
 * own long-press (`data-touch-longpress`: the lanes, the EQ graph, …) are left
 * alone. Touch and pen only: a mouse never sees this.
 */
export function TouchTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  /** a tooltip is showing for the press that's down */
  const shown = useRef(false);
  /** the click that may follow a press that showed its tooltip is swallowed until then (performance.now ms) */
  const swallowUntil = useRef(0);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      clear();
      shown.current = false;
      swallowUntil.current = 0;
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest('[data-touch-longpress]')) return;
      const owner = el.closest('[title]');
      const text = owner?.getAttribute('title');
      if (!text) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer.current = setTimeout(() => {
        shown.current = true;
        setTip({ x: e.clientX, y: e.clientY, text });
      }, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (s && e.pointerId === s.id && Math.hypot(e.clientX - s.x, e.clientY - s.y) > TOUCH_SLOP_PX) clear();
    };
    const up = (e: PointerEvent) => {
      if (start.current?.id !== e.pointerId) return;
      clear();
      start.current = null;
      // (the click a browser may send right after this release belongs to the long-press: not a tap)
      if (shown.current) swallowUntil.current = performance.now() + 400;
      shown.current = false;
      setTip(null);
    };
    // a press that showed its tooltip doesn't also click what it rested on
    const click = (e: MouseEvent) => {
      if (performance.now() > swallowUntil.current) return;
      swallowUntil.current = 0;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('pointerdown', down, { capture: true, passive: true });
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    window.addEventListener('pointerup', up, { capture: true, passive: true });
    window.addEventListener('pointercancel', up, { capture: true, passive: true });
    window.addEventListener('click', click, true);
    return () => {
      clear();
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('click', click, true);
    };
  }, []);

  if (!tip) return null;
  const w = Math.min(320, window.innerWidth - 16);
  return (
    <div
      data-testid="touch-tooltip"
      className="pointer-events-none fixed z-[200] rounded bg-black/90 px-2 py-1 text-[12px] leading-snug text-fg shadow-lg"
      style={{ left: Math.max(8, Math.min(window.innerWidth - w - 8, tip.x - w / 2)), top: Math.max(8, tip.y - 70), maxWidth: w }}
    >
      {tip.text}
    </div>
  );
}
