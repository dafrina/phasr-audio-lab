/**
 * A wind-up toy monkey sitting on the Monkey See, Monkey Seq window with a toy keyboard in
 * its lap, "playing" every note the arp or sequencer plays: the left paw takes
 * the low keys, the right paw the high ones, accents hit harder, the head bobs.
 *
 * Built for zero per-frame work: the drawing is static; arms, head and key
 * lights are separate layers moved only with CSS transforms / opacity
 * (compositor), each hit is a short Web Animation started when a note plays,
 * and blinking / breathing are CSS keyframes. Follows the live arp
 * (engine.onArpNote) and clip playback (a light check of the track's notes at
 * the playhead, only while the song plays). Still for prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';
import { engine } from '../../audio/engine';
import { withToolsExpanded } from '../../arp/expand';
import { getProject } from '../../state/projectStore';

const FUR = '#7a4a26';
const SKIN = '#e8c9a0';
const RED = '#c8102e';
const GOLD = '#d9b44a';
/** white-key index (0..6) for a pitch class (black keys go to the key below) */
const KEY_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const KEY_W = 10.8;
const KEYS_X = 22;
const KEY_TOP = 96;
/** shoulders and resting paws (px in the 120 × 110 figure) */
const SHOULDER = [
  { x: 45, y: 63 },
  { x: 75, y: 63 },
];
const REST = [
  { x: 36, y: 84 },
  { x: 84, y: 84 },
];
/** arm graphic: drawn hanging straight down from the shoulder, this long */
const ARM_LEN = 23;

const deg = (dx: number, dy: number) => (Math.atan2(-dx, dy) * 180) / Math.PI;
const restAngle = REST.map((r, h) => deg(r.x - SHOULDER[h]!.x, r.y - SHOULDER[h]!.y));
const restScale = REST.map((r, h) => Math.hypot(r.x - SHOULDER[h]!.x, r.y - SHOULDER[h]!.y) / ARM_LEN);

const CSS = `
@keyframes phasr-monkey-blink { 0%, 95%, 100% { transform: scaleY(0); } 97% { transform: scaleY(1); } }
@keyframes phasr-monkey-breathe { from { transform: scale(1); } to { transform: scale(1.015); } }
@keyframes phasr-monkey-sway { from { transform: rotate(-2.5deg); } to { transform: rotate(2.5deg); } }
@media (prefers-reduced-motion: reduce) { .phasr-monkey * { animation: none !important; } }
`;

export function ArpMonkey({ x, y, trackId }: { x: number; y: number; trackId: string }) {
  const arms = useRef<(HTMLDivElement | null)[]>([]);
  const keys = useRef<(HTMLDivElement | null)[]>([]);
  const head = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let lastHand: 0 | 1 = 1;
    let lastAt = 0;
    const strike = (pitch: number, velocity: number, delayMs: number) => {
      const key = KEY_OF_PC[((pitch % 12) + 12) % 12] as number;
      let hand: 0 | 1 = key <= 2 ? 0 : key >= 4 ? 1 : lastHand === 0 ? 1 : 0;
      const at = performance.now() + delayMs;
      // quick repeats on one side alternate paws, like a drummer
      if (hand === lastHand && at - lastAt < 90) hand = hand === 0 ? 1 : 0;
      lastHand = hand;
      lastAt = at;
      const s = SHOULDER[hand]!;
      const kx = KEYS_X + (key + 0.5) * KEY_W;
      const hitA = deg(kx - s.x, KEY_TOP - s.y);
      const hitS = Math.hypot(kx - s.x, KEY_TOP - s.y) / ARM_LEN;
      const power = Math.min(1, 0.55 + velocity / 200);
      const a0 = restAngle[hand]!;
      const s0 = restScale[hand]!;
      const lift = a0 + (hand === 0 ? -8 : 8);
      const arm = arms.current[hand];
      arm?.animate(
        [
          { transform: `rotate(${a0}deg) scaleY(${s0})` },
          { transform: `rotate(${lift}deg) scaleY(${s0 * 0.9})`, offset: 0.25 },
          { transform: `rotate(${a0 + (hitA - a0) * power}deg) scaleY(${s0 + (hitS - s0) * power})`, offset: 0.45 },
          { transform: `rotate(${a0}deg) scaleY(${s0})` },
        ],
        { duration: 190, delay: delayMs, easing: 'ease-out' },
      );
      keys.current[key]?.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 220, delay: delayMs + 70, easing: 'ease-out' });
      head.current?.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${(1.2 + power).toFixed(1)}px)`, offset: 0.4 }, { transform: 'translateY(0)' }], { duration: 200, delay: delayMs });
    };

    // live arp notes (scheduled a little ahead: start the animation when the note sounds)
    const off = engine.onArpNote((tid, pitch, velocity, at) => {
      if (tid !== trackId) return;
      const ctx = engine.ctx;
      strike(pitch, velocity, ctx ? Math.max(0, (at - ctx.currentTime) * 1000) : 0);
    });

    // clip playback: a light check at the playhead while the song plays (no drawing)
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

  const layer = 'absolute left-0 top-0 h-full w-full';
  return (
    <div aria-hidden className="phasr-monkey pointer-events-none fixed z-40" style={{ left: x, top: y, width: 120, height: 110 }}>
      <style>{CSS}</style>
      {/* body (breathing) */}
      <div className={layer} style={{ transformOrigin: '60px 92px', animation: 'phasr-monkey-breathe 1.4s ease-in-out infinite alternate', willChange: 'transform' }}>
        <svg viewBox="0 0 120 110" width={120} height={110} className="overflow-visible">
          <ellipse cx={60} cy={109} rx={46} ry={3} fill="#000" opacity={0.35} />
          <ellipse cx={60} cy={74} rx={21} ry={19} fill={FUR} />
          <ellipse cx={60} cy={78} rx={13} ry={12} fill={SKIN} />
          <path d="M41 66 Q44 84 50 92 L46 92 Q38 82 39 68 Z" fill={RED} />
          <path d="M79 66 Q76 84 70 92 L74 92 Q82 82 81 68 Z" fill={RED} />
          <path d="M54 55 L60 57 L54 59 Z M66 55 L60 57 L66 59 Z" fill={GOLD} />
          <circle cx={60} cy={57} r={2.6} fill={GOLD} />
        </svg>
      </div>
      {/* head (sways; bobs on hits) */}
      <div ref={head} className={layer} style={{ willChange: 'transform' }}>
        <div className={layer} style={{ transformOrigin: '60px 55px', animation: 'phasr-monkey-sway 2.2s ease-in-out infinite alternate' }}>
          <svg viewBox="0 0 120 110" width={120} height={110} className="overflow-visible">
            <circle cx={42} cy={41} r={6.5} fill={FUR} />
            <circle cx={42} cy={41} r={3.4} fill={SKIN} />
            <circle cx={78} cy={41} r={6.5} fill={FUR} />
            <circle cx={78} cy={41} r={3.4} fill={SKIN} />
            <circle cx={60} cy={40} r={17} fill={FUR} />
            <ellipse cx={60} cy={46} rx={12.5} ry={10} fill={SKIN} />
            <ellipse cx={60} cy={36} rx={10} ry={6} fill={SKIN} />
            <circle cx={54.5} cy={38} r={3.6} fill="#fff" />
            <circle cx={65.5} cy={38} r={3.6} fill="#fff" />
            <circle cx={55} cy={38.6} r={1.9} fill="#1a1a1a" />
            <circle cx={65} cy={38.6} r={1.9} fill="#1a1a1a" />
            <ellipse cx={60} cy={45} rx={2.6} ry={1.6} fill="#4a2a14" />
            <path d="M54 49 Q60 54 66 49" stroke="#4a2a14" strokeWidth={1.4} fill="none" strokeLinecap="round" />
            <path d="M52 24 L68 24 L66 15 L54 15 Z" fill={RED} />
            <rect x={52} y={22.5} width={16} height={2} fill="#9e0c24" />
            <path d="M60 15 Q66 13 67 21" stroke={GOLD} strokeWidth={1.2} fill="none" />
            <circle cx={67} cy={22} r={1.5} fill={GOLD} />
          </svg>
          {/* eyelids: a CSS blink */}
          {[54.5, 65.5].map((cx) => (
            <div
              key={cx}
              className="absolute rounded-full"
              style={{ left: cx - 4, top: 34, width: 8, height: 8, background: SKIN, transformOrigin: '50% 0', animation: `phasr-monkey-blink ${cx < 60 ? 4.3 : 4.3}s linear infinite`, willChange: 'transform' }}
            />
          ))}
        </div>
      </div>
      {/* toy keyboard, with a light layer per key */}
      <svg viewBox="0 0 120 110" width={120} height={110} className={`${layer} overflow-visible`}>
        <rect x={18} y={91} width={84} height={18} rx={3} fill={RED} />
        {Array.from({ length: 7 }, (_, k) => (
          <rect key={k} x={KEYS_X + k * KEY_W + 0.6} y={95} width={KEY_W - 1.2} height={11} rx={1.2} fill="#fbfbf6" />
        ))}
      </svg>
      {Array.from({ length: 7 }, (_, k) => (
        <div
          key={k}
          ref={(el) => {
            keys.current[k] = el;
          }}
          className="absolute rounded-[1px]"
          style={{ left: KEYS_X + k * KEY_W + 0.6, top: 95, width: KEY_W - 1.2, height: 11, background: '#ffd166', opacity: 0, willChange: 'opacity' }}
        />
      ))}
      <svg viewBox="0 0 120 110" width={120} height={110} className={`${layer} overflow-visible`}>
        {[0, 1, 3, 4, 5].map((k) => (
          <rect key={k} x={KEYS_X + (k + 1) * KEY_W - 2.6} y={95} width={5.2} height={6.5} rx={0.8} fill="#1a1a1a" />
        ))}
      </svg>
      {/* arms: a static drawing each, turned and stretched by transforms around the shoulder */}
      {[0, 1].map((h) => (
        <div
          key={h}
          ref={(el) => {
            arms.current[h] = el;
          }}
          className="absolute"
          style={{
            left: SHOULDER[h]!.x - 5,
            top: SHOULDER[h]!.y - 3,
            width: 10,
            height: ARM_LEN + 8,
            transformOrigin: '5px 3px',
            transform: `rotate(${restAngle[h]}deg) scaleY(${restScale[h]})`,
            willChange: 'transform',
          }}
        >
          <svg viewBox={`0 0 10 ${ARM_LEN + 8}`} width={10} height={ARM_LEN + 8} className="overflow-visible">
            <line x1={5} y1={3} x2={5} y2={ARM_LEN + 3} stroke={FUR} strokeWidth={6.5} strokeLinecap="round" />
            <circle cx={5} cy={ARM_LEN + 3} r={4.6} fill={SKIN} />
          </svg>
        </div>
      ))}
    </div>
  );
}
