/**
 * A pair of slippers hanging from the Slipper-izer window like a charm from a
 * rear-view mirror. Each slipper is a damped pendulum driven by the window's
 * own acceleration: drag the window and they swing, stop and they settle.
 * Purely decorative (no pointer events); still for prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';

const GOLD = '#d9b44a';
/** cord lengths (px) from the ring to each slipper's centre of mass */
const LENGTHS = [58, 66];
/** px/s² — a little more than "real" so it swings lively at UI scale */
const GRAVITY = 2200;
/** 1/s: how quickly a swing dies down */
const DAMPING = [1.1, 1.4];

interface Props {
  /** pivot (the ring) in viewport px: bottom edge of the window */
  x: number;
  y: number;
}

export function DanglingSlippers({ x, y }: Props) {
  const anchor = useRef({ x, y });
  anchor.current = { x, y };
  const groups = useRef<(SVGGElement | null)[]>([]);
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const th = [0.25, -0.18]; // start with a little swing so it's noticeable when the window opens
    const om = [0, 0];
    let last = performance.now();
    let prev = { ...anchor.current };
    let vel = { x: 0, y: 0 };
    let raf = 0;
    let still = 0;
    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const a = anchor.current;
      const nv = { x: (a.x - prev.x) / dt, y: (a.y - prev.y) / dt };
      // pivot acceleration (clamped: a window jump must not fling them into orbit)
      const ax = Math.max(-40000, Math.min(40000, (nv.x - vel.x) / dt));
      const ay = Math.max(-40000, Math.min(40000, (nv.y - vel.y) / dt));
      vel = nv;
      prev = { ...a };
      const sub = 4;
      const h = dt / sub;
      let energy = 0;
      for (let k = 0; k < 2; k++) {
        const L = LENGTHS[k] as number;
        let t = th[k] as number;
        let w = om[k] as number;
        for (let s = 0; s < sub; s++) {
          // θ'' = −((g − a_y)·sin θ + a_x·cos θ) / L − c·θ'   (θ from vertical, y pointing down)
          const acc = -((GRAVITY - ay) * Math.sin(t) + ax * Math.cos(t)) / L - (DAMPING[k] as number) * w;
          w += acc * h;
          t += w * h;
        }
        // they hang from one ring: a gentle nudge apart so the pair doesn't overlap
        th[k] = Math.max(-1.4, Math.min(1.4, t));
        om[k] = w;
        energy += Math.abs(t) + Math.abs(w);
        const g = groups.current[k];
        if (g) g.setAttribute('transform', `rotate(${(t * 180) / Math.PI} 0 4)`);
      }
      const moving = Math.abs(nv.x) + Math.abs(nv.y) > 1;
      still = !moving && energy < 0.002 ? still + 1 : 0;
      if (still > 30) {
        raf = 0; // settled: sleep until the window moves again
        return;
      }
      raf = requestAnimationFrame(step);
    };
    wake.current = () => {
      if (raf) return;
      last = performance.now();
      prev = { ...anchor.current };
      vel = { x: 0, y: 0 };
      still = 0;
      raf = requestAnimationFrame(step);
    };
    wake.current();
    return () => cancelAnimationFrame(raf);
  }, []);

  // the window moved: let the physics loop run
  useEffect(() => wake.current(), [x, y]);

  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed z-40"
      style={{ left: x - 60, top: y - 4, width: 120, height: 130, overflow: 'visible' }}
      viewBox="-60 -4 120 130"
    >
      {/* the hook on the window and the ring */}
      <rect x={-5} y={-4} width={10} height={4} rx={1.5} fill="#3a3320" />
      <circle cx={0} cy={4} r={4} fill="none" stroke={GOLD} strokeWidth={1.6} />
      {[0, 1].map((k) => (
        <g key={k} transform="rotate(0 0 4)" ref={(el) => {
            groups.current[k] = el;
          }}>
          <g transform="translate(0 7)">
            {/* cord */}
            <path d={`M0 0 L${k === 0 ? -10 : 10} ${(LENGTHS[k] as number) - 30}`} stroke="#a89060" strokeWidth={1.2} fill="none" />
            <g transform={`translate(${k === 0 ? -10 : 10} ${(LENGTHS[k] as number) - 30}) rotate(${k === 0 ? 8 : -8}) scale(1.3)`}>
              <Slipper mirrored={k === 1} />
            </g>
          </g>
        </g>
      ))}
    </svg>
  );
}

/** One slide sandal seen from above, heel up (where the cord holds it), toe down. ~22 × 46 units (drawn at 1.3×). */
function Slipper({ mirrored }: { mirrored: boolean }) {
  const sole = 'M0 0 C 8 0 10 7 9.5 16 C 9 25 11.5 33 10 40 C 8.5 47 -8.5 47 -10 40 C -11.5 33 -9 25 -9.5 16 C -10 7 -8 0 0 0 Z';
  const bed = 'M0 2.2 C 6.4 2.2 8 8 7.6 16 C 7.2 24 9.4 32 8 38.5 C 6.8 44 -6.8 44 -8 38.5 C -9.4 32 -7.2 24 -7.6 16 C -8 8 -6.4 2.2 0 2.2 Z';
  return (
    <g transform={mirrored ? 'scale(-1 1)' : undefined}>
      <path d={sole} fill="#141417" stroke="#2c2c33" strokeWidth={0.8} />
      <path d={bed} fill="#26262d" />
      {/* little hole the cord goes through */}
      <circle cx={0} cy={3.6} r={1.1} fill="#0b0b0e" />
      {/* the wide band over the front of the foot: green · red · green on cream */}
      <g>
        <rect x={-11.2} y={22} width={22.4} height={13} rx={3} fill="#efe6d0" stroke="#c9bd9f" strokeWidth={0.5} />
        <rect x={-11.2} y={25.2} width={22.4} height={2.2} fill="#1f7a3a" />
        <rect x={-11.2} y={27.4} width={22.4} height={2.4} fill="#c8102e" />
        <rect x={-11.2} y={29.8} width={22.4} height={2.2} fill="#1f7a3a" />
      </g>
      {/* a touch of shine */}
      <path d="M-5 6 C -6 10 -6.3 14 -6 17" stroke="#ffffff22" strokeWidth={1.2} fill="none" strokeLinecap="round" />
    </g>
  );
}
