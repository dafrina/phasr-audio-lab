/**
 * The Arp-Ape-ator's gorilla: he leans on a rail on top of the window and
 * drums on it for every note the arp / sequencer plays. He looks at the step
 * (or key) that lights up for the note and hits with the fist on that side;
 * quick runs alternate fists, accents hit harder, sparks fly where a fist lands.
 *
 * The drawing is a picture cut into a few still layers (body, head, rail, two
 * hands, two spark bursts; made from one illustration by a slicing script,
 * the spots behind the hands painted over with forearm fur, the head's lower
 * edge feathered into the neck). Nothing is redrawn per frame: the layers
 * only move with CSS transforms / opacity (compositor), each hit is a short
 * Web Animation timed so the fist lands as its note sounds, and a slow breath
 * is a CSS keyframe. Still for prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';
import bodyUrl from './ape/body.webp';
import headUrl from './ape/head.webp';
import railUrl from './ape/rail.webp';
import hand0Url from './ape/hand0.webp';
import hand1Url from './ape/hand1.webp';
import spark0Url from './ape/spark0.webp';
import spark1Url from './ape/spark1.webp';
import type { ArpBeat } from './arpBeats';

/** a note for the gorilla: when it lands, and the point on screen it lights up (to look at) */
export interface ApeHit extends ArpBeat {
  target: { x: number; y: number } | null;
}
export type ApeHits = Set<(h: ApeHit) => void>;

/** source-picture pixels → CSS px (the layers are exported at 2× this) */
const K = 0.15;
/** the figure's top-left corner in the source picture */
const O = { x: 111, y: 98 };
/** layer boxes in source-picture pixels (from the slicing script's layout) */
const SRC = {
  body: { x: 111, y: 471, w: 1034, h: 461 },
  head: { x: 342, y: 98, w: 605, h: 592 },
  rail: { x: 111, y: 881, w: 1034, h: 51 },
  hand0: { x: 284, y: 732, w: 237, h: 169 },
  hand1: { x: 751, y: 760, w: 210, h: 151 },
  spark0: { x: 144, y: 761, w: 93, h: 87 },
  spark1: { x: 974, y: 773, w: 90, h: 81 },
} as const;
type Part = keyof typeof SRC;
const box = (p: Part) => {
  const b = SRC[p];
  return { left: (b.x - O.x) * K, top: (b.y - O.y) * K, width: b.w * K, height: b.h * K };
};

/** the whole figure, CSS px */
export const APE_W = 1034 * K;
export const APE_H = (932 - O.y) * K;
/** the rail's middle line, from the figure's top (sit this on the window's top edge) */
export const APE_RAIL_Y = (SRC.rail.y + SRC.rail.h / 2 - O.y) * K;

/** wrist pivots inside each hand layer, CSS px */
const PIVOT = [
  { x: (330 - SRC.hand0.x) * K, y: (762 - SRC.hand0.y) * K },
  { x: (880 - SRC.hand1.x) * K, y: (774 - SRC.hand1.y) * K },
];
/** the neck (head pivot), CSS px in the figure */
const NECK = { x: (630 - O.x) * K, y: (690 - O.y) * K };
/** eyes, CSS px in the figure (where he looks from) */
const EYES = { x: (640 - O.x) * K, y: (460 - O.y) * K };
/** where on the rail each fist lands (glow centre), CSS px from the figure's left */
const LAND = [(430 - O.x) * K, (870 - O.x) * K];
/** pitch class → 0 left fist, 1 right fist, 2 either (when nothing lit up to look at) */
const PC_HAND = [0, 0, 0, 0, 2, 2, 2, 2, 1, 1, 1, 1];
const GLOW = '#6d6bff';
/** the hit animation's length and where in it the fist lands */
const HIT_MS = 210;
const LAND_AT = 0.5;
/** how long he keeps looking after the last note */
const LOOK_HOLD_MS = 1300;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const CSS = `
@keyframes phasr-ape-breathe { from { transform: scale(1); } to { transform: scale(1.008, 1.016); } }
@media (prefers-reduced-motion: reduce) { .phasr-ape * { animation: none !important; } }
`;

const img = (url: string, p: Part, extra?: React.CSSProperties) => (
  <img src={url} alt="" draggable={false} decoding="async" className="absolute max-w-none select-none" style={{ ...box(p), ...extra }} />
);

export function ArpApe({ x, y, hits }: { x: number; y: number; hits: ApeHits }) {
  const root = useRef<HTMLDivElement>(null);
  const hands = useRef<(HTMLDivElement | null)[]>([]);
  const sparks = useRef<(HTMLImageElement | null)[]>([]);
  const glows = useRef<(HTMLDivElement | null)[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let lastHand: 0 | 1 = 1;
    let lastAt = 0;
    let lookBack: ReturnType<typeof setTimeout> | null = null;
    const look = (transform: string, delay: number, duration: number) =>
      head.current?.animate([{ transform }], { duration, delay, fill: 'forwards', easing: 'cubic-bezier(.3,.7,.4,1)' });

    const strike = (b: ApeHit) => {
      const landMs = b.landMs;
      // which side the lit step / key is on, seen from his eyes
      const r = root.current?.getBoundingClientRect();
      const dx = b.target && r ? b.target.x - (r.left + EYES.x) : 0;
      const dy = b.target && r ? b.target.y - (r.top + EYES.y) : 0;
      const pref = b.target ? (dx < -14 ? 0 : dx > 14 ? 1 : 2) : (PC_HAND[((b.pitch % 12) + 12) % 12] as number);
      let hand: 0 | 1 = pref === 2 ? (lastHand === 0 ? 1 : 0) : (pref as 0 | 1);
      const at = performance.now() + landMs;
      // quick repeats alternate fists, like a drummer
      if (hand === lastHand && at - lastAt < 120) hand = hand === 0 ? 1 : 0;
      lastHand = hand;
      lastAt = at;
      const p = Math.min(1, 0.45 + b.velocity / 200);
      const sign = hand === 0 ? -1 : 1;
      // start early enough that the landing is on the note (late if it is already due)
      const delay = Math.max(0, landMs - HIT_MS * LAND_AT);
      const lift = (5 + 7 * p).toFixed(1);
      const tilt = (sign * (10 + 10 * p)).toFixed(1);
      hands.current[hand]?.animate(
        [
          { transform: 'none' },
          { transform: `translate(${sign * 0.8}px, -${lift}px) rotate(${tilt}deg)`, offset: LAND_AT * 0.7, easing: 'ease-in' },
          { transform: `translate(0, ${(0.6 + 0.8 * p).toFixed(1)}px) scale(1.05, ${(0.95 - 0.05 * p).toFixed(2)})`, offset: LAND_AT, easing: 'ease-out' },
          { transform: 'none' },
        ],
        { duration: HIT_MS, delay },
      );
      const land = delay + HIT_MS * LAND_AT;
      sparks.current[hand]?.animate(
        [
          { opacity: 0, transform: 'scale(0.6)' },
          { opacity: 0.6 + 0.4 * p, transform: `scale(${(0.95 + 0.25 * p).toFixed(2)})`, offset: 0.2 },
          { opacity: 0, transform: `scale(${(1.15 + 0.25 * p).toFixed(2)})` },
        ],
        { duration: 300, delay: land, easing: 'ease-out' },
      );
      glows.current[hand]?.animate(
        [
          { opacity: 0, transform: 'scale(0.6, 0.6)' },
          { opacity: 0.5 + 0.5 * p, transform: 'scale(1, 1)', offset: 0.15 },
          { opacity: 0, transform: 'scale(1.7, 1.1)' },
        ],
        { duration: 320, delay: land, easing: 'ease-out' },
      );
      body.current?.animate(
        [{ transform: 'none' }, { transform: `translateY(${(0.8 + 1.2 * p).toFixed(1)}px)`, offset: 0.3 }, { transform: 'none' }],
        { duration: 220, delay: Math.max(0, land - 40) },
      );
      // look at what lights up: lean the head that way and a little down
      if (b.target) {
        const a = clamp(dx * 0.014, -4, 4);
        const tx = clamp(dx * 0.005, -1.6, 1.6);
        const ty = clamp(dy * 0.006, 0, 1.3);
        look(`translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${a.toFixed(2)}deg)`, Math.max(0, landMs - 140), 150);
        if (lookBack) clearTimeout(lookBack);
        lookBack = setTimeout(() => look('none', 0, 600), landMs + LOOK_HOLD_MS);
      }
    };

    hits.add(strike);
    return () => {
      hits.delete(strike);
      if (lookBack) clearTimeout(lookBack);
    };
  }, [hits]);

  return (
    <div ref={root} aria-hidden className="phasr-ape pointer-events-none fixed z-40" style={{ left: x, top: y, width: APE_W, height: APE_H }}>
      <style>{CSS}</style>
      {/* body and head behind the rail (clipped at the rail so a bob never pokes out under it) */}
      <div className="absolute inset-0 overflow-hidden">
        <div ref={body} className="absolute inset-0" style={{ willChange: 'transform' }}>
          <div className="absolute inset-0" style={{ transformOrigin: `50% ${APE_RAIL_Y}px`, animation: 'phasr-ape-breathe 1.9s ease-in-out infinite alternate', willChange: 'transform' }}>
            {img(bodyUrl, 'body')}
            <div ref={head} className="absolute inset-0" style={{ transformOrigin: `${NECK.x}px ${NECK.y}px`, willChange: 'transform' }}>
              {img(headUrl, 'head')}
            </div>
          </div>
        </div>
      </div>
      {img(railUrl, 'rail')}
      {/* where the fists land: the rail lights up */}
      {LAND.map((lx, h) => (
        <div
          key={h}
          ref={(el) => {
            glows.current[h] = el;
          }}
          className="absolute rounded-[50%]"
          style={{ left: lx - 18, top: APE_RAIL_Y - 5, width: 36, height: 10, background: `radial-gradient(closest-side, ${GLOW}, rgba(109,107,255,0))`, opacity: 0, willChange: 'transform, opacity' }}
        />
      ))}
      {(['hand0', 'hand1'] as const).map((part, h) => (
        <div
          key={part}
          ref={(el) => {
            hands.current[h] = el;
          }}
          className="absolute"
          style={{ ...box(part), transformOrigin: `${PIVOT[h]!.x}px ${PIVOT[h]!.y}px`, willChange: 'transform' }}
        >
          <img src={h === 0 ? hand0Url : hand1Url} alt="" draggable={false} decoding="async" className="absolute inset-0 h-full w-full max-w-none select-none" />
        </div>
      ))}
      {(['spark0', 'spark1'] as const).map((part, h) => (
        <img
          key={part}
          ref={(el) => {
            sparks.current[h] = el;
          }}
          src={h === 0 ? spark0Url : spark1Url}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute max-w-none select-none"
          style={{ ...box(part), opacity: 0, transformOrigin: h === 0 ? '100% 100%' : '0% 100%', willChange: 'transform, opacity' }}
        />
      ))}
    </div>
  );
}
