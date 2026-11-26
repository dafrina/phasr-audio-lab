/**
 * A pair of slippers hanging from the Slipper-izer window like a charm from a
 * rear-view mirror.
 *
 * Each cord is a short rope (Verlet points + distance constraints) hung from
 * the ring on the window's edge, with the slipper as a heavier weight at its
 * end. The rope follows the ring's real position, so the pair always lags
 * behind a drag in the right direction, the cord bends a little on quick
 * moves, and the two slippers bump into each other. The loop sleeps once
 * everything is still; nothing moves with prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';

const GOLD = '#d9b44a';
/** rope segments per cord */
const SEGS = 5;
/** cord lengths (px) from the ring to each slipper's heel */
const CORD = [40, 47];
/** px/s² — a little livelier than real gravity at UI scale */
const GRAVITY = 1800;
/** velocity kept per 1/60 s (air drag) */
const DRAG = 0.986;
/** the slippers keep at least this far apart (px between heels) */
const SPREAD = 19;
/** inverse masses: ring fixed, cord light, slipper heavy */
const INV_CORD = 1;
const INV_SLIPPER = 0.2;
const SLIPPER_SCALE = 1.3;

interface Props {
  /** pivot (the ring) in viewport px: bottom edge of the window */
  x: number;
  y: number;
}

type Pt = { x: number; y: number; px: number; py: number };

function restRope(ax: number, ay: number, k: number): Pt[] {
  const side = k === 0 ? -1 : 1;
  const len = CORD[k] as number;
  const pts: Pt[] = [];
  for (let i = 0; i <= SEGS; i++) {
    const f = i / SEGS;
    const x = ax + side * (SPREAD / 2) * f;
    const y = ay + 4 + len * f;
    pts.push({ x, y, px: x, py: y });
  }
  return pts;
}

export function DanglingSlippers({ x, y }: Props) {
  const anchor = useRef({ x, y });
  anchor.current = { x, y };
  const svg = useRef<SVGSVGElement>(null);
  const cords = useRef<(SVGPathElement | null)[]>([]);
  const slippers = useRef<(SVGGElement | null)[]>([]);
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    let ropes = [0, 1].map((k) => restRope(anchor.current.x, anchor.current.y, k));
    const draw = () => {
      const a = anchor.current;
      const el = svg.current;
      if (el) {
        el.style.left = `${a.x - 80}px`;
        el.style.top = `${a.y - 4}px`;
      }
      ropes.forEach((r, k) => {
        const loc = r.map((p) => ({ x: p.x - a.x, y: p.y - a.y }));
        // smooth cord through the points (midpoint quadratic curves)
        const first = loc[0] as { x: number; y: number };
        let d = `M${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
        for (let i = 1; i < loc.length - 1; i++) {
          const p = loc[i] as { x: number; y: number };
          const n = loc[i + 1] as { x: number; y: number };
          d += ` Q${p.x.toFixed(2)} ${p.y.toFixed(2)} ${((p.x + n.x) / 2).toFixed(2)} ${((p.y + n.y) / 2).toFixed(2)}`;
        }
        const end = loc[loc.length - 1] as { x: number; y: number };
        d += ` L${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
        cords.current[k]?.setAttribute('d', d);
        // the slipper hangs along the end of its cord
        const prev = loc[loc.length - 2] as { x: number; y: number };
        const deg = (-Math.atan2(end.x - prev.x, end.y - prev.y) * 180) / Math.PI;
        slippers.current[k]?.setAttribute('transform', `translate(${end.x.toFixed(2)} ${end.y.toFixed(2)}) rotate(${deg.toFixed(2)}) scale(${SLIPPER_SCALE})`);
      });
    };

    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      draw();
      wake.current = () => {
        ropes = [0, 1].map((k) => restRope(anchor.current.x, anchor.current.y, k));
        draw();
      };
      return;
    }
    // a little swing when the window opens, so the charm says hello
    for (const r of ropes) (r[SEGS] as Pt).px -= 2.5;

    let raf = 0;
    let last = performance.now();
    let still = 0;
    const step = (now: number) => {
      const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
      last = now;
      const a = anchor.current;
      const drag = Math.pow(DRAG, dt * 60);
      let motion = 0;
      let ringMoved = 0;
      for (const r of ropes) {
        // the top of the cord is tied to the ring
        const top = r[0] as Pt;
        ringMoved += Math.abs(a.x - top.x) + Math.abs(a.y + 4 - top.y);
        top.px = top.x;
        top.py = top.y;
        top.x = a.x;
        top.y = a.y + 4;
        for (let i = 1; i <= SEGS; i++) {
          const p = r[i] as Pt;
          const vx = (p.x - p.px) * drag;
          const vy = (p.y - p.py) * drag;
          p.px = p.x;
          p.py = p.y;
          p.x += vx;
          p.y += vy + GRAVITY * dt * dt;
          motion += Math.abs(vx) + Math.abs(vy);
        }
      }
      // constraints: cord lengths, a little stiffness, and the two slippers not overlapping
      for (let it = 0; it < 14; it++) {
        ropes.forEach((r, k) => {
          const seg = (CORD[k] as number) / SEGS;
          for (let i = 0; i < SEGS; i++) {
            const p = r[i] as Pt;
            const q = r[i + 1] as Pt;
            const wp = i === 0 ? 0 : INV_CORD;
            const wq = i + 1 === SEGS ? INV_SLIPPER : INV_CORD;
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const dist = Math.hypot(dx, dy) || 1e-6;
            const diff = (dist - seg) / dist / (wp + wq);
            p.x += dx * diff * wp;
            p.y += dy * diff * wp;
            q.x -= dx * diff * wq;
            q.y -= dy * diff * wq;
          }
          // a cord bends, but not like wet string: every second point stays near its straight distance
          for (let i = 0; i + 2 <= SEGS; i++) {
            const p = r[i] as Pt;
            const q = r[i + 2] as Pt;
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const dist = Math.hypot(dx, dy) || 1e-6;
            const min = 2 * seg * 0.92;
            if (dist >= min) continue;
            const wp = i === 0 ? 0 : INV_CORD;
            const wq = i + 2 === SEGS ? INV_SLIPPER : INV_CORD;
            const diff = ((dist - min) / dist / (wp + wq)) * 0.25;
            p.x += dx * diff * wp;
            p.y += dy * diff * wp;
            q.x -= dx * diff * wq;
            q.y -= dy * diff * wq;
          }
        });
        // the slippers push each other apart (they hang from one ring)
        const e0 = (ropes[0] as Pt[])[SEGS] as Pt;
        const e1 = (ropes[1] as Pt[])[SEGS] as Pt;
        const dx = e1.x - e0.x;
        const dy = e1.y - e0.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        if (dist < SPREAD) {
          const push = (SPREAD - dist) / dist / 2;
          e0.x -= dx * push;
          e0.y -= dy * push;
          e1.x += dx * push;
          e1.y += dy * push;
        }
      }
      draw();
      still = ringMoved < 0.01 && motion < 0.02 ? still + 1 : 0;
      if (still > 40) {
        raf = 0; // settled: sleep until the window moves again
        return;
      }
      raf = requestAnimationFrame(step);
    };
    wake.current = () => {
      if (raf) return;
      last = performance.now();
      still = 0;
      raf = requestAnimationFrame(step);
    };
    draw();
    wake.current();
    return () => cancelAnimationFrame(raf);
  }, []);

  // the window moved: let the rope loop run
  useEffect(() => wake.current(), [x, y]);

  return (
    <svg ref={svg} aria-hidden className="pointer-events-none fixed z-40" style={{ left: x - 80, top: y - 4, width: 160, height: 140, overflow: 'visible' }} viewBox="-80 -4 160 140">
      {/* the hook on the window and the ring */}
      <rect x={-5} y={-4} width={10} height={4} rx={1.5} fill="#3a3320" />
      <circle cx={0} cy={4} r={4} fill="none" stroke={GOLD} strokeWidth={1.6} />
      {[0, 1].map((k) => (
        <g key={k}>
          <path
            ref={(el) => {
              cords.current[k] = el;
            }}
            stroke="#a89060"
            strokeWidth={1.2}
            strokeLinecap="round"
            fill="none"
          />
          <g
            ref={(el) => {
              slippers.current[k] = el;
            }}
          >
            {/* drawn with the cord's hole at the origin */}
            <g transform="translate(0 -3.6)">
              <Slipper mirrored={k === 1} />
            </g>
          </g>
        </g>
      ))}
    </svg>
  );
}

/** One slide sandal seen from above, heel up (where the cord holds it), toe down. ~22 × 46 units. */
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
      <rect x={-11.2} y={22} width={22.4} height={13} rx={3} fill="#efe6d0" stroke="#c9bd9f" strokeWidth={0.5} />
      <rect x={-11.2} y={25.2} width={22.4} height={2.2} fill="#1f7a3a" />
      <rect x={-11.2} y={27.4} width={22.4} height={2.4} fill="#c8102e" />
      <rect x={-11.2} y={29.8} width={22.4} height={2.2} fill="#1f7a3a" />
      {/* a touch of shine */}
      <path d="M-5 6 C -6 10 -6.3 14 -6 17" stroke="#ffffff22" strokeWidth={1.2} fill="none" strokeLinecap="round" />
    </g>
  );
}
