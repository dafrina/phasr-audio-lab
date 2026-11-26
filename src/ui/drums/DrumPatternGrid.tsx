/**
 * Drum step grid: one 16-step row per pad, editing a MIDI clip of the Drum
 * Rack track directly (each cell is a note on that pad). Click: hit on / off.
 * Shift-click: normal → accent → ghost. Right-click: roll 1 → 2 → 3 → 4 hits
 * inside the step. The playing step lights up.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { engine } from '../../audio/engine';
import { createId } from '../../core/ids';
import { PPQ, ticksPerBar } from '../../core/time';
import { DRUM_PADS, padNote } from '../../drums/kit';
import { createMidiClip } from '../../project/defaults';
import { fitClipToNotes } from '../../project/noteOps';
import type { DrumPad, MidiClip, MidiNote } from '../../project/types';
import { getProject, upsertClips, useProjectStore } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';

const ACCENT = '#fb923c';
const STEP = PPQ / 4; // 1/16
const VEL_NORMAL = 100;
const VEL_ACCENT = 127;
const VEL_GHOST = 55;

export function DrumPatternGrid({ trackId, pads, onPickPad }: { trackId: string; pads: DrumPad[]; onPickPad: (i: number) => void }) {
  // (select the stable clip map; a derived array here would be a new value on every read)
  const allClips = useProjectStore((s) => s.project.clips);
  const clips = useMemo(
    () =>
      Object.values(allClips)
        .filter((c): c is MidiClip => c.kind === 'midi' && c.trackId === trackId)
        .sort((a, b) => a.start - b.start),
    [allClips, trackId],
  );
  const ts = useProjectStore((s) => s.project.timeSignature);
  const selected = useUiStore((s) => s.selectedClipIds);
  const clip = clips.find((c) => selected.includes(c.id)) ?? clips[0];
  const bar = ticksPerBar(ts);
  const stepsPerBar = Math.max(1, Math.round(bar / STEP));
  const [page, setPage] = useState(0);
  const [playStep, setPlayStep] = useState(-1);
  const clipRef = useRef<MidiClip | undefined>(clip);
  clipRef.current = clip;

  const cycle = clip ? (clip.loop && clip.loopLength > 0 ? clip.loopLength : clip.length) : bar;
  const bars = Math.max(1, Math.ceil(cycle / bar));
  const pg = Math.min(page, bars - 1);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = engine.transport;
      const c = clipRef.current;
      if (!t || !c || !t.isPlaying()) {
        setPlayStep((s) => (s === -1 ? s : -1));
        return;
      }
      const cyc = c.loop && c.loopLength > 0 ? c.loopLength : c.length;
      const rel = t.getTick() - c.start;
      const s = rel >= 0 && rel < c.length ? Math.floor((rel % cyc) / STEP) : -1;
      setPlayStep((p) => (p === s ? p : s));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!clip) {
    const create = () => {
      const c = createMidiClip(trackId, 0, bar);
      c.name = 'Pattern';
      upsertClips([c], 'New drum pattern');
      useUiStore.getState().set({ selectedClipIds: [c.id] });
    };
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-[12px] text-muted">
        This track has no clip to edit yet.
        <button type="button" onClick={create} className="flex h-7 items-center gap-1 rounded px-3 text-[12px] font-semibold text-black" style={{ background: ACCENT }}>
          <Plus size={13} /> New 1-bar pattern at bar 1
        </button>
      </div>
    );
  }

  const cellNotes = (c: MidiClip, pad: number, step: number) => {
    const s0 = step * STEP;
    const pitch = padNote(pad);
    return c.notes.filter((n) => n.pitch === pitch && n.start >= s0 && n.start < s0 + STEP);
  };
  const commit = (notes: MidiNote[], label: string) => {
    const c = getProject().clips[clip.id];
    if (!c || c.kind !== 'midi') return;
    upsertClips([fitClipToNotes({ ...c, notes }, bar)], label);
  };
  const live = () => {
    const c = getProject().clips[clip.id];
    return c && c.kind === 'midi' ? c : clip;
  };
  const toggle = (pad: number, step: number, e: React.MouseEvent) => {
    const c = live();
    const mine = cellNotes(c, pad, step);
    const rest = c.notes.filter((n) => !mine.includes(n));
    if (e.shiftKey && mine.length) {
      // normal → accent → ghost → normal
      const v = mine[0]!.velocity;
      const next = v >= VEL_ACCENT ? VEL_GHOST : v <= VEL_GHOST ? VEL_NORMAL : VEL_ACCENT;
      commit([...rest, ...mine.map((n) => ({ ...n, velocity: next }))], 'Drum step velocity');
      return;
    }
    if (mine.length) {
      commit(rest, 'Drum step off');
      return;
    }
    commit([...rest, { id: createId('n'), pitch: padNote(pad), start: step * STEP, length: STEP / 2, velocity: VEL_NORMAL }], 'Drum step on');
    engine.previewNoteOn(trackId, padNote(pad), 0.8);
  };
  const roll = (pad: number, step: number) => {
    const c = live();
    const mine = cellNotes(c, pad, step);
    const rest = c.notes.filter((n) => !mine.includes(n));
    const r = mine.length ? (mine.length % 4) + 1 : 2;
    const vel = mine[0]?.velocity ?? VEL_NORMAL;
    const hits = Array.from({ length: r }, (_, k) => ({ id: createId('n'), pitch: padNote(pad), start: step * STEP + (k * STEP) / r, length: STEP / r / 2, velocity: Math.max(1, vel - k * 8) }));
    commit([...rest, ...hits], 'Drum step roll');
  };
  const addBar = () => {
    const c = live();
    const length = c.length + bar;
    upsertClips([{ ...c, length, loopLength: c.loop ? c.loopLength : length }], 'Longer drum pattern');
    setPage(bars);
  };

  const first = pg * stepsPerBar;
  const cols = { gridTemplateColumns: `96px repeat(${stepsPerBar}, minmax(0, 1fr))` };
  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-medium text-fg">{clip.name}</span>
        <span className="text-dim">bar</span>
        {Array.from({ length: bars }, (_, b) => (
          <button key={b} type="button" onClick={() => setPage(b)} className={`h-6 w-7 rounded ${b === pg ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`} style={b === pg ? { background: ACCENT } : undefined}>
            {b + 1}
          </button>
        ))}
        <button type="button" onClick={addBar} title="Make the pattern a bar longer" className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-muted hover:text-fg">
          <Plus size={11} /> bar
        </button>
        <span className="ml-auto text-[10px] text-dim">Click: hit · Shift-click: normal → accent → ghost · Right-click: roll ×2 ×3 ×4 · {clips.length > 1 ? 'select another clip on the timeline to edit it' : 'edits this clip'}</span>
      </div>
      <div className="flex flex-col gap-[3px] rounded-md border border-line bg-panel-2 p-2" onContextMenu={(e) => e.preventDefault()}>
        {Array.from({ length: DRUM_PADS }, (_, pad) => (
          <div key={pad} className="grid gap-[3px]" style={cols}>
            <button
              type="button"
              onClick={() => {
                onPickPad(pad);
                engine.previewNoteOn(trackId, padNote(pad), 0.8);
              }}
              className="truncate rounded bg-panel-3 px-1.5 text-left text-[10px] text-fg hover:bg-line-2"
              title={`Play ${pads[pad]?.name ?? ''} (and select the pad)`}
            >
              {pads[pad]?.name ?? `Pad ${pad + 1}`}
            </button>
            {Array.from({ length: stepsPerBar }, (_, k) => {
              const step = first + k;
              const mine = cellNotes(clip, pad, step);
              const vel = mine[0]?.velocity ?? 0;
              const isPlay = step === playStep;
              const beat = k % 4 === 0;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={(e) => toggle(pad, step, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    roll(pad, step);
                  }}
                  className={`relative h-[18px] rounded ${beat ? 'ring-1 ring-line-2' : ''}`}
                  style={{
                    background: mine.length ? ACCENT : isPlay ? '#3a3326' : k % 8 < 4 ? '#1d1d27' : '#24242f',
                    opacity: mine.length ? (vel <= VEL_GHOST ? 0.45 : vel >= VEL_ACCENT ? 1 : 0.8) : 1,
                    outline: isPlay ? '1px solid #fff' : undefined,
                  }}
                  title={mine.length ? `${pads[pad]?.name}: ${vel >= VEL_ACCENT ? 'accent' : vel <= VEL_GHOST ? 'ghost' : 'hit'}${mine.length > 1 ? ` · roll ×${mine.length}` : ''}` : undefined}
                >
                  {mine.length > 1 && <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-black">×{mine.length}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
