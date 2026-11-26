/**
 * The Arp-Ape-ator's gorilla: he leans on a rail on top of the window and
 * drums on it for every note the arp / sequencer plays — low notes with the
 * left fist, high notes with the right, quick runs alternate, accents hit
 * harder, sparks fly where a fist lands.
 *
 * The drawing is a picture cut into a few still layers (body, rail, two
 * hands, two spark bursts; made from one illustration by a slicing script,
 * the hands' spots on the body painted over with forearm fur). Nothing is
 * redrawn per frame: the layers only move with CSS transforms / opacity
 * (compositor), each hit is a short Web Animation timed so the fist lands as
 * its note sounds (live arp via engine.onArpNote, clip playback via a light
 * check of the track's notes at the playhead while the song plays), and a
 * slow breath is a CSS keyframe. Still for prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';
import { engine } from '../../audio/engine';
import { withToolsExpanded } from '../../arp/expand';
import { getProject } from '../../state/projectStore';
import bodyUrl from './ape/body.webp';
import railUrl from './ape/rail.webp';
import hand0Url from './ape/hand0.webp';
import hand1Url from './ape/hand1.webp';
import spark0Url from './ape/spark0.webp';
import spark1Url from './ape/spark1.webp';

/** source-picture pixels → CSS px (the layers are exported at 2× this) */
const K = 0.15;
/** layer boxes in source-picture pixels (from the slicing script's layout) */
const SRC = {
  body: { x: 111, y: 98, w: 1034, h: 834 },
  rail: { x: 111, y: 881, w: 1034, h: 51 },
  hand0: { x: 284, y: 732, w: 237, h: 169 },
  hand1: { x: 751, y: 760, w: 210, h: 151 },
  spark0: { x: 144, y: 761, w: 93, h: 87 },
  spark1: { x: 974, y: 773, w: 90, h: 81 },
} as const;
type Part = keyof typeof SRC;
const box = (p: Part) => {
  const b = SRC[p];
  return { left: (b.x - SRC.body.x) * K, top: (b.y - SRC.body.y) * K, width: b.w * K, height: b.h * K };
};

/** the whole figure, CSS px */
export const APE_W = SRC.body.w * K;
export const APE_H = SRC.body.h * K;
/** the rail's middle line, from the figure's top (sit this on the window's top edge) */
export const APE_RAIL_Y = (SRC.rail.y + SRC.rail.h / 2 - SRC.body.y) * K;

/** wrist pivots inside each hand layer, CSS px */
const PIVOT = [
  { x: (330 - SRC.hand0.x) * K, y: (762 - SRC.hand0.y) * K },
  { x: (880 - SRC.hand1.x) * K, y: (774 - SRC.hand1.y) * K },
];
/** where on the rail each fist lands (glow centre), CSS px from the figure's left */
const LAND = [(430 - SRC.body.x) * K, (870 - SRC.body.x) * K];
/** pitch class → 0 left fist, 1 right fist, 2 either */
const PC_HAND = [0, 0, 0, 0, 2, 2, 2, 2, 1, 1, 1, 1];
const GLOW = '#6d6bff';
/** the hit animation's length and where in it the fist lands */
const HIT_MS = 210;
const LAND_AT = 0.5;

const CSS = `
@keyframes phasr-ape-breathe { from { transform: scale(1); } to { transform: scale(1.008, 1.016); } }
@media (prefers-reduced-motion: reduce) { .phasr-ape * { animation: none !important; } }
`;

const img = (url: string, p: Part, extra?: React.CSSProperties) => (
  <img src={url} alt="" draggable={false} decoding="async" className="absolute max-w-none select-none" style={{ ...box(p), ...extra }} />
);

export function ArpApe({ x, y, trackId }: { x: number; y: number; trackId: string }) {
  const hands = useRef<(HTMLDivElement | null)[]>([]);
  const sparks = useRef<(HTMLImageElement | null)[]>([]);
  const glows = useRef<(HTMLDivElement | null)[]>([]);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let lastHand: 0 | 1 = 1;
    let lastAt = 0;
    /** a fist lands `landMs` from now */
    const strike = (pitch: number, velocity: number, landMs: number) => {
      const pref = PC_HAND[((pitch % 12) + 12) % 12] as number;
      let hand: 0 | 1 = pref === 2 ? (lastHand === 0 ? 1 : 0) : (pref as 0 | 1);
      const at = performance.now() + landMs;
      // quick repeats alternate fists, like a drummer
      if (hand === lastHand && at - lastAt < 120) hand = hand === 0 ? 1 : 0;
      lastHand = hand;
      lastAt = at;
      const p = Math.min(1, 0.45 + velocity / 200);
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
        { duration: 220, delay: land - 40 > 0 ? land - 40 : 0 },
      );
    };

    const off = engine.onArpNote((tid, pitch, velocity, at) => {
      if (tid !== trackId) return;
      const ctx = engine.ctx;
      strike(pitch, velocity, ctx ? Math.max(0, (at - ctx.currentTime) * 1000) : 0);
    });

    let lastTick = -1;
    const timer = setInterval(() => {
      const t = engine.transport;
      if (!t || !t.isPlaying()) {
        lastTick = -1;
        return;
      }
      const now = t.getTick();
      if (lastTick < 0 || now < lastTick || now - lastTick > 3840) {
        lastTick = now;
        return;
      }
      const p = withToolsExpanded(getProject());
      let n = 0;
      for (const c of Object.values(p.clips)) {
        if (c.kind !== 'midi' || c.trackId !== trackId) continue;
        for (const note of c.notes) {
          const s = c.start + note.start;
          if (s > lastTick && s <= now && n++ < 4) strike(note.pitch, note.velocity, 0);
        }
      }
      lastTick = now;
    }, 15);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [trackId]);

  return (
    <div aria-hidden className="phasr-ape pointer-events-none fixed z-40" style={{ left: x, top: y, width: APE_W, height: APE_H }}>
      <style>{CSS}</style>
      {/* body behind the rail (clipped at the rail so a bob never pokes out under it) */}
      <div className="absolute inset-0 overflow-hidden">
        <div ref={body} className="absolute inset-0" style={{ willChange: 'transform' }}>
          <div className="absolute inset-0" style={{ transformOrigin: `50% ${APE_RAIL_Y}px`, animation: 'phasr-ape-breathe 1.9s ease-in-out infinite alternate', willChange: 'transform' }}>
            {img(bodyUrl, 'body')}
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
