/**
 * The step sequencer's melody lane: a small piano roll, one column per step.
 * Each playing step is a bar at its pitch (semitones from the key you hold),
 * coloured like the note. Drag up / down to set it, drag across steps to draw
 * a line (an empty step you draw on turns on), wheel to nudge, right-click
 * to clear a step. With a scale picked, pitches snap to it and the other rows
 * are dimmed. Every new pitch is played once so you hear what you draw.
 */
import { useMemo, useRef } from 'react';
import { ARP_SCALES, SEQ_STEPS, inScale, snapToScale, stepInScale, type ArpConfig, type ArpScale, type SeqStep } from '../../arp/arp';
import { engine } from '../../audio/engine';
import { noteColor } from './arpBeats';

const H = 132;
const GAP = 3;
const NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/** what the lane assumes you hold (names, colours, auditioning) */
const BASE = 60;

export const noteNameOf = (semis: number) => NAMES[(((semis % 12) + 12) % 12) as number] as string;

export function PitchLane({
  trackId,
  cfg,
  cols,
  onSteps,
  onScale,
}: {
  trackId: string;
  cfg: ArpConfig;
  /** the grid's column template (label column + steps) */
  cols: React.CSSProperties;
  /** change the steps (given the current ones; a drag coalesces into one undo step) */
  onSteps: (fn: (steps: SeqStep[]) => SeqStep[]) => void;
  onScale: (s: ArpScale) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ last: number[] } | null>(null);
  // ±1 octave, or ±2 once a step goes beyond
  const range = cfg.steps.some((s) => s.on && Math.abs(s.transpose) > 12) ? 24 : 12;
  const rows = range * 2 + 1;
  const rowH = H / rows;
  const yOf = (t: number) => (range - t) * rowH;

  const bg = useMemo(() => {
    const stops: string[] = [];
    for (let k = 0; k < rows; k++) {
      const t = range - k;
      const c = t === 0 ? 'rgba(34,211,238,0.22)' : t % 12 === 0 ? 'rgba(255,255,255,0.10)' : inScale(cfg.scale, t) ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.25)';
      stops.push(`${c} ${(k * rowH).toFixed(2)}px ${((k + 1) * rowH - (rowH > 4 ? 0.6 : 0)).toFixed(2)}px`, `rgba(0,0,0,0) ${((k + 1) * rowH - (rowH > 4 ? 0.6 : 0)).toFixed(2)}px ${((k + 1) * rowH).toFixed(2)}px`);
    }
    return `linear-gradient(to bottom, ${stops.join(', ')})`;
  }, [rows, range, rowH, cfg.scale]);

  const hit = (e: React.PointerEvent) => {
    const r = lane.current!.getBoundingClientRect();
    const colW = (r.width - GAP * (SEQ_STEPS - 1)) / SEQ_STEPS;
    const i = Math.max(0, Math.min(SEQ_STEPS - 1, Math.floor((e.clientX - r.left) / (colW + GAP))));
    const t = range - Math.floor(((e.clientY - r.top) / r.height) * rows);
    return { i, t: snapToScale(cfg.scale, Math.max(-range, Math.min(range, t))) };
  };
  const apply = (i: number, t: number) => (steps: SeqStep[]): SeqStep[] => steps.map((s, j) => (j === i ? { ...s, on: true, transpose: t } : s));

  const down = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const { i, t } = hit(e);
    if (i >= cfg.length) return;
    drag.current = { last: Array(SEQ_STEPS).fill(NaN) };
    drag.current.last[i] = t;
    onSteps(apply(i, t));
    engine.auditionNote(trackId, BASE + t, cfg.steps[i]?.vel ?? 0.8);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { i, t } = hit(e);
    if (i >= cfg.length || d.last[i] === t) return;
    d.last[i] = t;
    onSteps(apply(i, t));
    engine.auditionNote(trackId, BASE + t, cfg.steps[i]?.vel ?? 0.8);
  };
  const up = () => (drag.current = null);

  return (
    <>
      <div className="grid gap-[3px]" style={cols}>
        <div className="flex flex-col justify-between py-0.5 text-[9px] uppercase tracking-wider text-muted">
          <span title="Each step's pitch, from the key you hold">Melody</span>
          <select value={cfg.scale} onChange={(e) => onScale(e.target.value as ArpScale)} className="h-5 w-[60px] text-[10px] normal-case tracking-normal" title="Snap the melody to a scale (relative to the key you hold)">
            {ARP_SCALES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="normal-case tracking-normal text-dim">±{range}</span>
        </div>
        <div
          ref={lane}
          data-touch-longpress
          className="relative grid cursor-ns-resize touch-none select-none gap-[3px]"
          style={{ gridColumn: '2 / -1', gridTemplateColumns: `repeat(${SEQ_STEPS}, minmax(0, 1fr))`, height: H }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => {
            e.preventDefault();
            const r = lane.current!.getBoundingClientRect();
            const colW = (r.width - GAP * (SEQ_STEPS - 1)) / SEQ_STEPS;
            const i = Math.floor((e.clientX - r.left) / (colW + GAP));
            if (i >= 0 && i < SEQ_STEPS) onSteps((steps) => steps.map((s, j) => (j === i ? { ...s, on: false, tie: false } : s)));
          }}
          onWheel={(e) => {
            if (!e.deltaY) return;
            const r = lane.current!.getBoundingClientRect();
            const colW = (r.width - GAP * (SEQ_STEPS - 1)) / SEQ_STEPS;
            const i = Math.floor((e.clientX - r.left) / (colW + GAP));
            const s = cfg.steps[i];
            if (!s?.on) return;
            const t = stepInScale(cfg.scale, s.transpose, e.deltaY < 0 ? 1 : -1);
            if (t === s.transpose) return;
            onSteps((steps) => steps.map((x, j) => (j === i ? { ...x, transpose: t } : x)));
            engine.auditionNote(trackId, BASE + t, s.vel);
          }}
          title="Drag up / down to set a step's pitch, across steps to draw a line · wheel: nudge · right-click: clear the step"
        >
          {cfg.steps.map((s, i) => {
            const off = i >= cfg.length;
            const next = cfg.steps[(i + 1) % SEQ_STEPS];
            const tiesOn = s.on && s.tie && next?.on && i + 1 < cfg.length;
            return (
              <div key={i} className={`relative rounded-sm ${off ? 'opacity-25' : ''} ${i % 4 === 0 ? 'ring-1 ring-line-2' : ''}`} style={{ background: bg }}>
                {s.on && (
                  <div
                    className="pointer-events-none absolute rounded-[3px]"
                    style={{
                      left: 2,
                      right: tiesOn ? -GAP - 2 : 2,
                      top: yOf(s.transpose) - (rowH < 5 ? (5 - rowH) / 2 : 0),
                      height: Math.max(5, rowH),
                      background: noteColor(BASE + s.transpose),
                      opacity: 0.45 + 0.55 * s.vel,
                      boxShadow: `0 0 6px ${noteColor(BASE + s.transpose)}`,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid gap-[3px]" style={cols}>
        <div className="flex items-center text-[9px] uppercase tracking-wider text-muted" title="Note names if you hold C">
          Note (C)
        </div>
        {cfg.steps.map((s, i) => (
          <div key={i} className={`flex h-5 select-none items-center justify-center gap-1 rounded bg-panel-3 text-[10px] ${!s.on || i >= cfg.length ? 'opacity-20' : 'text-fg'}`}>
            {s.on ? (
              <>
                <span className="font-semibold" style={{ color: noteColor(BASE + s.transpose) }}>
                  {noteNameOf(s.transpose)}
                </span>
                <span className="text-[9px] text-dim">{s.transpose > 0 ? `+${s.transpose}` : s.transpose}</span>
              </>
            ) : (
              '·'
            )}
          </div>
        ))}
      </div>
    </>
  );
}
