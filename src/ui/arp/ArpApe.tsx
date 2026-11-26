/**
 * The Arp-Ape-ator's gorilla: he sits on the window and drums on its top
 * frame for every note the arp / sequencer plays — low notes land to the
 * left, high notes to the right, accents hit harder, and the frame glows where
 * a fist lands. Shaded drawing (gradients), no costume.
 *
 * Zero per-frame drawing: static SVG layers moved only with CSS transforms /
 * opacity (compositor); each hit is a short Web Animation started when its
 * note sounds (live arp via engine.onArpNote, clip playback via a light check
 * of the track's notes at the playhead while the song plays); blinking and a
 * slow breath are CSS keyframes. Still for prefers-reduced-motion.
 */
import { useEffect, useId, useRef } from 'react';
import { engine } from '../../audio/engine';
import { withToolsExpanded } from '../../arp/expand';
import { getProject } from '../../state/projectStore';

const W = 140;
const H = 116;
/** the window frame line (bottom of the figure) */
const FRAME = 112;
/** where fists can land on the frame, left to right (by pitch) */
const SLOTS = Array.from({ length: 7 }, (_, k) => 22 + (k * 96) / 6);
const SHOULDER = [
  { x: 42, y: 58 },
  { x: 98, y: 58 },
];
const REST = [
  { x: 33, y: FRAME - 2 },
  { x: 107, y: FRAME - 2 },
];
/** arm graphic: hangs straight down from the shoulder, fist centre this far down */
const ARM_LEN = 52;
const ARM_W = 26;
const PC_SLOT = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const GLOW = '#22d3ee';

const deg = (dx: number, dy: number) => (Math.atan2(-dx, dy) * 180) / Math.PI;
const reach = (h: number, x: number, y: number) => {
  const s = SHOULDER[h]!;
  return { a: deg(x - s.x, y - s.y), s: Math.hypot(x - s.x, y - s.y) / ARM_LEN };
};
const REST_POSE = REST.map((r, h) => reach(h, r.x, r.y));

const CSS = `
@keyframes phasr-ape-blink { 0%, 94%, 100% { transform: scaleY(0); } 96% { transform: scaleY(1); } }
@keyframes phasr-ape-breathe { from { transform: scale(1); } to { transform: scale(1.012, 1.02); } }
@keyframes phasr-ape-look { 0%, 40% { transform: rotate(-2deg); } 60%, 100% { transform: rotate(2.5deg); } }
@media (prefers-reduced-motion: reduce) { .phasr-ape * { animation: none !important; } }
`;

export function ArpApe({ x, y, trackId }: { x: number; y: number; trackId: string }) {
  const arms = useRef<(HTMLDivElement | null)[]>([]);
  const glows = useRef<(HTMLDivElement | null)[]>([]);
  const head = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const g = (name: string) => `${name}${uid}`;

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    let lastHand: 0 | 1 = 1;
    let lastAt = 0;
    const strike = (pitch: number, velocity: number, delayMs: number) => {
      const slot = PC_SLOT[((pitch % 12) + 12) % 12] as number;
      let hand: 0 | 1 = slot <= 2 ? 0 : slot >= 4 ? 1 : lastHand === 0 ? 1 : 0;
      const at = performance.now() + delayMs;
      // quick repeats alternate fists, like a drummer
      if (hand === lastHand && at - lastAt < 110) hand = hand === 0 ? 1 : 0;
      lastHand = hand;
      lastAt = at;
      const power = Math.min(1, 0.55 + velocity / 220);
      const rest = REST_POSE[hand]!;
      const hit = reach(hand, SLOTS[slot]!, FRAME - 1);
      // wind up: the fist rises outward and back, then slams onto the frame
      const up = reach(hand, REST[hand]!.x + (hand === 0 ? -10 : 10) * power, FRAME - 18 - 14 * power);
      arms.current[hand]?.animate(
        [
          { transform: `rotate(${rest.a}deg) scaleY(${rest.s})` },
          { transform: `rotate(${up.a}deg) scaleY(${up.s})`, offset: 0.35, easing: 'ease-in' },
          { transform: `rotate(${hit.a}deg) scaleY(${hit.s})`, offset: 0.55, easing: 'ease-out' },
          { transform: `rotate(${rest.a}deg) scaleY(${rest.s})` },
        ],
        { duration: 230, delay: delayMs },
      );
      glows.current[slot]?.animate(
        [
          { opacity: 0, transform: 'scale(0.6, 0.6)' },
          { opacity: 0.55 + 0.45 * power, transform: 'scale(1, 1)', offset: 0.15 },
          { opacity: 0, transform: 'scale(1.6, 1.1)' },
        ],
        { duration: 320, delay: delayMs + 125, easing: 'ease-out' },
      );
      head.current?.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${(1 + 1.5 * power).toFixed(1)}px)`, offset: 0.55 }, { transform: 'translateY(0)' }], { duration: 240, delay: delayMs });
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

  const layer = 'absolute left-0 top-0';
  return (
    <div aria-hidden className="phasr-ape pointer-events-none fixed z-40" style={{ left: x, top: y, width: W, height: H }}>
      <style>{CSS}</style>
      {/* contact shadow on the frame */}
      <div className="absolute rounded-[50%]" style={{ left: 20, top: FRAME - 4, width: 100, height: 8, background: 'radial-gradient(closest-side, rgba(0,0,0,0.55), rgba(0,0,0,0))' }} />
      {/* torso (slow breath) */}
      <div className={layer} style={{ width: W, height: H, transformOrigin: `70px ${FRAME}px`, animation: 'phasr-ape-breathe 1.8s ease-in-out infinite alternate', willChange: 'transform' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="overflow-visible">
          <defs>
            <radialGradient id={g('fur')} cx="45%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#5a5a64" />
              <stop offset="55%" stopColor="#2f2f36" />
              <stop offset="100%" stopColor="#141418" />
            </radialGradient>
            <radialGradient id={g('chest')} cx="50%" cy="35%" r="70%">
              <stop offset="0%" stopColor="#5c514c" />
              <stop offset="100%" stopColor="#2a2422" />
            </radialGradient>
            <linearGradient id={g('rim')} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#8a8a96" stopOpacity="0.35" />
              <stop offset="30%" stopColor="#8a8a96" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* back and shoulders */}
          <path d="M26 66 Q24 44 48 38 Q70 32 92 38 Q116 44 114 66 Q116 96 98 111 L42 111 Q24 96 26 66 Z" fill={`url(#${g('fur')})`} />
          <path d="M26 66 Q24 44 48 38 Q70 32 92 38 Q116 44 114 66 Q116 96 98 111 L42 111 Q24 96 26 66 Z" fill={`url(#${g('rim')})`} />
          {/* chest */}
          <path d="M50 62 Q70 54 90 62 Q96 86 84 104 Q70 110 56 104 Q44 86 50 62 Z" fill={`url(#${g('chest')})`} />
          <path d="M58 70 Q70 66 82 70" stroke="#1c1716" strokeWidth={1.2} fill="none" opacity={0.6} />
        </svg>
      </div>
      {/* head: looks around slowly, bobs on hits */}
      <div ref={head} className={layer} style={{ width: W, height: H, willChange: 'transform' }}>
        <div className={layer} style={{ width: W, height: H, transformOrigin: '70px 46px', animation: 'phasr-ape-look 5s ease-in-out infinite alternate' }}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="overflow-visible">
            <defs>
              <radialGradient id={g('skull')} cx="42%" cy="25%" r="80%">
                <stop offset="0%" stopColor="#62626c" />
                <stop offset="60%" stopColor="#2c2c33" />
                <stop offset="100%" stopColor="#121215" />
              </radialGradient>
              <radialGradient id={g('face')} cx="45%" cy="35%" r="75%">
                <stop offset="0%" stopColor="#6b605b" />
                <stop offset="70%" stopColor="#3a3330" />
                <stop offset="100%" stopColor="#221d1b" />
              </radialGradient>
            </defs>
            {/* skull with the gorilla's crest */}
            <path d="M48 34 Q46 10 70 5 Q94 10 92 34 Q93 48 70 50 Q47 48 48 34 Z" fill={`url(#${g('skull')})`} />
            <ellipse cx={64} cy={12} rx={9} ry={4} fill="#ffffff" opacity={0.07} />
            {/* face */}
            <path d="M54 30 Q54 21 70 21 Q86 21 86 30 Q88 43 78 47 Q70 50 62 47 Q52 43 54 30 Z" fill={`url(#${g('face')})`} />
            {/* heavy brow, shading the eyes */}
            <path d="M53 27 Q61 20 70 24 Q79 20 87 27 Q80 30 70 29 Q60 30 53 27 Z" fill="#1d1918" />
            <circle cx={63.5} cy={31.2} r={2.1} fill="#150f0d" />
            <circle cx={76.5} cy={31.2} r={2.1} fill="#150f0d" />
            <circle cx={64.1} cy={30.6} r={0.65} fill="#ffffff" opacity={0.8} />
            <circle cx={77.1} cy={30.6} r={0.65} fill="#ffffff" opacity={0.8} />
            {/* broad nose and mouth */}
            <ellipse cx={70} cy={38.5} rx={6.4} ry={3.8} fill="#4b4240" />
            <ellipse cx={67.2} cy={39.3} rx={1.7} ry={1.15} fill="#120d0c" />
            <ellipse cx={72.8} cy={39.3} rx={1.7} ry={1.15} fill="#120d0c" />
            <ellipse cx={69} cy={36.6} rx={2.6} ry={1} fill="#ffffff" opacity={0.08} />
            <path d="M62 44.2 Q70 46.6 78 44.2" stroke="#120d0c" strokeWidth={1.3} fill="none" strokeLinecap="round" />
          </svg>
          {[63.5, 76.5].map((cx) => (
            <div key={cx} className="absolute rounded-full" style={{ left: cx - 2.8, top: 28.6, width: 5.6, height: 5, background: '#3a3330', transformOrigin: '50% 0', animation: 'phasr-ape-blink 5.2s linear infinite', willChange: 'transform' }} />
          ))}
        </div>
      </div>
      {/* where the fists land: the frame lights up */}
      {SLOTS.map((sx, k) => (
        <div
          key={k}
          ref={(el) => {
            glows.current[k] = el;
          }}
          className="absolute rounded-[50%]"
          style={{ left: sx - 16, top: FRAME - 5, width: 32, height: 10, background: `radial-gradient(closest-side, ${GLOW}, rgba(34,211,238,0))`, opacity: 0, willChange: 'transform, opacity' }}
        />
      ))}
      {/* arms: static drawings turned and stretched around the shoulder */}
      {[0, 1].map((h) => (
        <div
          key={h}
          ref={(el) => {
            arms.current[h] = el;
          }}
          className="absolute"
          style={{
            left: SHOULDER[h]!.x - ARM_W / 2,
            top: SHOULDER[h]!.y - 4,
            width: ARM_W,
            height: ARM_LEN + 12,
            transformOrigin: `${ARM_W / 2}px 4px`,
            transform: `rotate(${REST_POSE[h]!.a}deg) scaleY(${REST_POSE[h]!.s})`,
            willChange: 'transform',
          }}
        >
          <svg viewBox={`0 0 ${ARM_W} ${ARM_LEN + 12}`} width={ARM_W} height={ARM_LEN + 12} className="overflow-visible">
            <defs>
              <linearGradient id={g(`arm${h}`)} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#141418" />
                <stop offset={h === 0 ? '35%' : '55%'} stopColor="#4c4c56" />
                <stop offset="100%" stopColor="#141418" />
              </linearGradient>
              <radialGradient id={g(`fist${h}`)} cx="45%" cy="35%" r="70%">
                <stop offset="0%" stopColor="#5d534e" />
                <stop offset="100%" stopColor="#221d1b" />
              </radialGradient>
            </defs>
            {/* upper arm into a thick forearm */}
            <path d={`M2 6 Q${ARM_W / 2} -3 ${ARM_W - 2} 6 Q${ARM_W + 1} ${ARM_LEN * 0.45} ${ARM_W - 3} ${ARM_LEN - 4} Q${ARM_W / 2} ${ARM_LEN + 1} 3 ${ARM_LEN - 4} Q-1 ${ARM_LEN * 0.45} 2 6 Z`} fill={`url(#${g(`arm${h}`)})`} />
            {/* fist with knuckles */}
            <ellipse cx={ARM_W / 2} cy={ARM_LEN} rx={9.5} ry={7.5} fill={`url(#${g(`fist${h}`)})`} />
            {[-5, -1.7, 1.7, 5].map((dx) => (
              <path key={dx} d={`M${ARM_W / 2 + dx - 1.4} ${ARM_LEN + 3.5} Q${ARM_W / 2 + dx} ${ARM_LEN + 5.2} ${ARM_W / 2 + dx + 1.4} ${ARM_LEN + 3.5}`} stroke="#120d0c" strokeWidth={0.9} fill="none" />
            ))}
          </svg>
        </div>
      ))}
    </div>
  );
}
