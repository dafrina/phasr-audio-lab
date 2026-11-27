/**
 * Arp-Ape-ator: an arpeggiator and a 16-step sequencer in front of any
 * instrument. Hold keys (computer keyboard, MIDI, the keybed below, or long
 * notes in a clip) and they play the pattern, locked to the song grid.
 *
 * The sequencer's pitches are drawn in a melody lane (PitchLane). Every note
 * the pattern plays lights its step / key (in the note's colour) and the
 * gorilla on the window drums along (ArpApe, fed by arpBeats).
 *
 * Rec: in the sequencer, step recording — each key you play fills the next
 * step (relative to the first key of the take) and moves on; Rest / Tie /
 * Back / Clear fill in the rest. In the arpeggiator, live recording onto the
 * timeline: the keys you hold become a clip that plays back through the arp.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Circle, Power, Repeat2, Wand2, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { recorder } from '../../audio/recorder';
import { useRecordingStore } from '../../state/recordingStore';
import { midiNoteName } from '../../core/time';
import { useWindowZ } from '../common/windowStack';
import { ARP_DIRECTIONS, ARP_PRESETS, ARP_RATES, SEQ_STEPS, arpPreset, type ArpConfig, type ArpScale, type SeqStep } from '../../arp/arp';
import { PitchLane } from './PitchLane';
import { arpActive, bakeArp } from '../../arp/expand';
import { getProject, updateTrack, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { APE_RAIL_Y, APE_W, ArpApe, type ApeHits } from './ArpApe';
import { noteColor, useArpBeats, type ArpBeat } from './arpBeats';
import { KeyboardStrip, useComputerKeyboard } from '../synth/KeyboardStrip';
import type { NumericParamSpec } from '../../synth/params';
import { PPQ } from '../../core/time';

const WIN_W = 940;
const CYAN = '#22d3ee';
const REC = '#ef4444';
/** a played note's step / key flashes this */
const FLASH = '#a5f3fc';
const GATE: NumericParamSpec = { label: 'Gate', min: 0.05, max: 1, default: 0.6, curve: 'linear', format: (v) => `${Math.round(v * 100)}%` };
const SWING: NumericParamSpec = { label: 'Swing', min: 0, max: 0.75, default: 0, curve: 'linear', format: (v) => `${Math.round(v * 100)}%` };

export function ArpWindow({ trackId }: { trackId: string }) {
  const win = useWindowZ('arp');
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const clipCount = useProjectStore((s) => Object.values(s.project.clips).filter((c) => c.trackId === trackId && c.kind === 'midi').length);
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 600) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const velDrag = useRef<number | null>(null);
  const [apeHits] = useState<ApeHits>(() => new Set());
  /** step recording: the step the next key fills, and the key the take is relative to */
  const [stepRec, setStepRec] = useState<{ cursor: number; root: number | null } | null>(null);
  const stepRecRef = useRef(stepRec);
  stepRecRef.current = stepRec;
  const recStatus = useRecordingStore((s) => s.status);
  const recTrack = useRecordingStore((s) => s.armedTrackId);
  const liveRec = recTrack === trackId && (recStatus === 'recording' || recStatus === 'countIn');

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    setUi({ arpTrackId: null });
  }, [trackId, setUi]);
  const kb = useComputerKeyboard(trackId, close, 0.85, 'arp');

  useEffect(() => {
    if (!track || track.kind !== 'instrument' || !track.arp) setUi({ arpTrackId: null });
  }, [track, setUi]);
  useEffect(() => root.current?.focus(), [trackId]);

  // the playing step (sequencer, while the song runs): its playhead overlay is shown directly,
  // so the window doesn't re-render on every step
  const cfgRef = useRef<ArpConfig | null>(null);
  cfgRef.current = track?.arp ?? null;
  useEffect(() => {
    let raf = 0;
    let shown: HTMLElement | null = null;
    const show = (step: number) => {
      const el = step >= 0 ? root.current?.querySelector<HTMLElement>(`[data-step="${step}"] > [data-playhead]`) ?? null : null;
      if (el === shown) return;
      if (shown) shown.style.opacity = '0';
      if (el) el.style.opacity = el.parentElement?.dataset.on === '1' ? '0.85' : '0.14';
      shown = el;
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = engine.transport;
      const c = cfgRef.current;
      if (!t || !c || c.mode !== 'seq' || !t.isPlaying()) return show(-1);
      const st = Math.max(1, Math.round(c.rate * PPQ));
      const len = Math.max(1, Math.min(SEQ_STEPS, c.length));
      show(Math.floor(t.getTick() / st) % len);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // every note the pattern plays: its step (sequencer) and its key flash as it sounds, and the gorilla hits it
  const onBeat = (b: ArpBeat) => {
    const el = root.current;
    const c = cfgRef.current;
    if (!el || !c) return;
    const len = Math.max(1, Math.min(SEQ_STEPS, c.length));
    const stepEl = c.mode === 'seq' ? el.querySelector<HTMLElement>(`[data-step="${((b.step % len) + len) % len}"]`) : null;
    const keyEl = el.querySelector<HTMLElement>(`[data-note="${b.pitch}"]`);
    const strength = 0.55 + 0.45 * Math.min(1, b.velocity / 110);
    const color = noteColor(b.pitch);
    for (const f of [stepEl, keyEl]) {
      const fl = f?.querySelector<HTMLElement>('[data-flash]');
      if (!fl) continue;
      fl.style.background = color;
      fl.style.boxShadow = `0 0 12px ${color}`;
      fl.animate(
        [{ opacity: 0 }, { opacity: strength, offset: 0.08 }, { opacity: 0 }],
        { duration: 280, delay: b.landMs, easing: 'ease-out' },
      );
    }
    const t = (stepEl ?? keyEl)?.getBoundingClientRect();
    const hit = { ...b, target: t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : null };
    for (const f of apeHits) f(hit);
  };
  useArpBeats(trackId, onBeat);
  const onBeatRef = useRef(onBeat);
  onBeatRef.current = onBeat;

  // step recording: keys play plain notes (not the pattern) and each one fills the next step
  const recOn = stepRec !== null;
  useEffect(() => {
    if (!recOn) return;
    engine.allNotesOff(trackId);
    engine.toolBypass.add(trackId);
    const off = engine.onLiveInput((e) => {
      if (e.trackId !== trackId || e.type !== 'noteOn') return;
      const r = stepRecRef.current;
      const cur = getProject().tracks.find((t) => t.id === trackId)?.arp;
      if (!r || !cur) return;
      const root = r.root ?? e.note;
      const len = Math.max(1, Math.min(SEQ_STEPS, cur.length));
      const i = r.cursor % len;
      const transpose = Math.max(-24, Math.min(24, e.note - root));
      const vel = Math.round(Math.max(0.05, Math.min(1, e.velocity)) * 100) / 100;
      updateTrack(trackId, { arp: { ...cur, presetName: 'Custom', steps: cur.steps.map((s, j) => (j === i ? { ...s, on: true, transpose, vel, tie: false } : s)) } }, 'Step record');
      const next = { cursor: (i + 1) % len, root };
      stepRecRef.current = next;
      setStepRec(next);
      onBeatRef.current({ pitch: e.note, velocity: Math.round(vel * 127), step: i, landMs: 0 });
    });
    return () => {
      off();
      engine.toolBypass.delete(trackId);
    };
  }, [recOn, trackId]);
  // step recording is a sequencer thing
  const isSeq = track?.arp?.mode === 'seq';
  useEffect(() => {
    if (!isSeq) setStepRec(null);
  }, [isSeq]);

  if (!track || !track.arp) return null;
  const cfg = track.arp;
  const on = arpActive(track);
  const seq = cfg.mode === 'seq';

  const set = (part: Partial<ArpConfig>, key: string) => {
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    updateTrack(trackId, { arp: { ...cur, ...part, presetName: part.presetName ?? (key === 'enabled' || key === 'latch' || key === 'scale' ? cur.presetName : 'Custom') } }, 'Edit Arp-Ape-ator', { coalesce: `arp-${trackId}-${key}` });
  };
  const setStep = (i: number, part: Partial<SeqStep>, key: string) => {
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    set({ steps: cur.steps.map((s, j) => (j === i ? { ...s, ...part } : s)) }, `${key}-${i}`);
  };
  const loadPreset = (name: string) => {
    const p = arpPreset(name);
    if (!p) return;
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    // (the melody lane's scale is a drawing aid: it stays as you set it)
    updateTrack(trackId, { arp: { ...structuredClone(p), enabled: cur.enabled, latch: cur.latch, scale: cur.scale } }, `Arp-Ape-ator: ${name}`);
  };

  // step-record helpers: Rest (an empty step), Tie (hold the previous note one more step), Back
  const recEdit = (kind: 'rest' | 'tie' | 'back' | 'clear') => {
    const r = stepRecRef.current;
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp;
    if (!r || !cur) return;
    const len = Math.max(1, Math.min(SEQ_STEPS, cur.length));
    const i = r.cursor % len;
    const prevI = (i - 1 + len) % len;
    let steps = cur.steps;
    let cursor = (i + 1) % len;
    if (kind === 'rest') steps = steps.map((s, j) => (j === i ? { ...s, on: false, tie: false } : s));
    else if (kind === 'tie') {
      const prev = steps[prevI];
      if (!prev?.on) return;
      steps = steps.map((s, j) => (j === prevI ? { ...s, tie: true } : j === i ? { ...s, on: true, transpose: prev.transpose, vel: prev.vel, tie: false } : s));
    } else if (kind === 'back') cursor = prevI;
    else {
      steps = steps.map((s) => ({ ...s, on: false, tie: false, transpose: 0 }));
      cursor = 0;
    }
    if (steps !== cur.steps) updateTrack(trackId, { arp: { ...cur, presetName: 'Custom', steps } }, kind === 'clear' ? 'Clear steps' : 'Step record');
    const next = { cursor, root: kind === 'clear' ? null : r.root };
    stepRecRef.current = next;
    setStepRec(next);
  };
  const toggleRec = async () => {
    if (seq) {
      setStepRec((r) => (r ? null : { cursor: 0, root: null }));
      return;
    }
    if (liveRec) {
      await recorder.stop();
      return;
    }
    if (!track.armed) await recorder.toggleArm(trackId);
    await recorder.start();
  };
  const recActive = seq ? stepRec !== null : liveRec;

  const bake = () => {
    if (!clipCount) {
      uiToast('info', 'There are no MIDI clips on this track to bake yet — record or draw some held notes first.');
      return;
    }
    if (!confirm(`Write the pattern into ${clipCount} clip${clipCount === 1 ? '' : 's'} on "${track.name}" as real notes? Arp-Ape-ator (and the Slipper-izer, if on) is switched off afterwards (Undo brings everything back).`)) return;
    useProjectStore.getState().commit('Bake arp to notes', (p) => bakeArp(p, trackId));
    uiToast('info', `Baked the pattern into ${clipCount} clip${clipCount === 1 ? '' : 's'}.`);
  };

  const seg = <T extends string | number>(value: T, options: { v: T; label: string; title?: string }[], onPick: (v: T) => void) => (
    <div className="inline-flex overflow-hidden rounded border border-line">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          title={o.title}
          onClick={() => onPick(o.v)}
          className={`h-6 whitespace-nowrap px-2 text-[11px] ${value === o.v ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
          style={value === o.v ? { background: CYAN } : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
  const label = (t: string) => <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-muted">{t}</span>;

  return (
    <>
    <div
      ref={root}
      tabIndex={-1}
      data-testid="arp-window"
      onPointerDownCapture={win.raise}
      style={{ left: pos.x, top: pos.y, width: WIN_W, zIndex: win.z }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70 outline-none"
      onPointerUp={() => (velDrag.current = null)}
    >
      <div
        className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-[#0f2a30] to-panel px-3"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input')) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          dragWin.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragWin.current;
          if (d) setPos({ x: Math.min(window.innerWidth - 120, Math.max(-800, e.clientX - d.dx)), y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)) });
        }}
        onPointerUp={() => (dragWin.current = null)}
      >
        <Repeat2 size={16} style={{ color: CYAN }} />
        <span className="text-[14px] font-bold tracking-[0.16em]" style={{ color: CYAN }}>
          ARP-APE-ATOR
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted">· arp &amp; step sequencer for {track.name}</span>
        <button
          type="button"
          title={on ? 'Switch Arp-Ape-ator off (keys play normally again)' : 'Switch Arp-Ape-ator on'}
          onClick={() => set({ enabled: !cfg.enabled }, 'enabled')}
          className={`ml-3 flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold ${on ? 'text-black' : 'bg-panel-3 text-muted'}`}
          style={on ? { background: CYAN } : undefined}
        >
          <Power size={12} /> {on ? 'On' : 'Off'}
        </button>
        <button
          type="button"
          data-testid="arp-rec"
          title={
            seq
              ? recActive
                ? 'Stop step recording'
                : 'Step record: each key you play fills the next step (relative to the first key) — Rest / Tie / Back fill in the gaps'
              : recActive
                ? 'Stop recording'
                : 'Record onto the timeline: the keys you hold become a clip that plays back through the arp (with the count-in)'
          }
          onClick={() => void toggleRec()}
          className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold ${recActive ? 'text-white' : 'bg-panel-3 text-muted hover:text-fg'} ${recActive && !seq && recStatus === 'countIn' ? 'animate-pulse' : ''}`}
          style={recActive ? { background: REC } : undefined}
        >
          <Circle size={10} fill="currentColor" style={recActive ? undefined : { color: REC }} /> {seq ? 'Step rec' : 'Rec'}
        </button>
        <select value={ARP_PRESETS.some((p) => p.presetName === cfg.presetName) ? cfg.presetName : ''} onChange={(e) => loadPreset(e.target.value)} className="h-6 max-w-[200px]" title="Pattern presets">
          <option value="">{cfg.presetName === 'Custom' ? 'Custom' : 'Presets…'}</option>
          <optgroup label="Arpeggiator">
            {ARP_PRESETS.filter((p) => p.mode === 'arp').map((p) => (
              <option key={p.presetName} value={p.presetName}>
                {p.presetName}
              </option>
            ))}
          </optgroup>
          <optgroup label="Step sequencer">
            {ARP_PRESETS.filter((p) => p.mode === 'seq').map((p) => (
              <option key={p.presetName} value={p.presetName}>
                {p.presetName}
              </option>
            ))}
          </optgroup>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" title="Write the pattern into this track's clips as real notes" onClick={bake} disabled={!on} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2 disabled:opacity-40">
            <Wand2 size={12} /> Bake to notes
          </button>
          <button type="button" title="Close (Esc)" onClick={close} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-3">
          {label('Mode')}
          {seg(cfg.mode, [
            { v: 'arp', label: 'Arpeggiator', title: 'Held notes one after another' },
            { v: 'seq', label: 'Step sequencer', title: 'A 16-step pattern played on the held key — press another key to transpose it' },
          ], (v) => set({ mode: v }, 'mode'))}
          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">Rate</span>
          {seg(cfg.rate, ARP_RATES.map((r) => ({ v: r.value, label: r.label })), (v) => set({ rate: v }, 'rate'))}
          <Knob spec={GATE} value={cfg.gate} size={26} color={CYAN} onChange={(v) => set({ gate: v }, 'gate')} title="Gate: how long each note lasts within its step" />
          <Knob spec={SWING} value={cfg.swing} size={26} color={CYAN} onChange={(v) => set({ swing: v }, 'swing')} title="Swing: every second step comes a little later" />
          <button
            type="button"
            title="Latch: the pattern keeps playing after you let go; the next press starts a new set"
            onClick={() => set({ latch: !cfg.latch }, 'latch')}
            className={`h-6 rounded px-2 text-[11px] font-semibold uppercase tracking-wide ${cfg.latch ? 'text-black' : 'bg-panel-3 text-muted'}`}
            style={cfg.latch ? { background: CYAN } : undefined}
          >
            Latch
          </button>
        </div>

        {!seq ? (
          <div className="flex flex-wrap items-center gap-3">
            {label('Direction')}
            {seg(cfg.direction, ARP_DIRECTIONS.map((d) => ({ v: d.value, label: d.label })), (v) => set({ direction: v }, 'dir'))}
            <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">Octaves</span>
            {seg(cfg.octaves, [1, 2, 3, 4].map((o) => ({ v: o, label: String(o) })), (v) => set({ octaves: v }, 'oct'))}
            <span className="text-[10px] text-dim">Hold a chord (or one key with the Slipper-izer on) — it plays the notes one by one.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              {label('Steps')}
              <select value={cfg.length} onChange={(e) => set({ length: Number(e.target.value) }, 'len')} className="h-6" title="Pattern length">
                {Array.from({ length: SEQ_STEPS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-dim">Click a step to turn it on · drag its bar for velocity · hold a key to hear it, press another key to transpose the whole line</span>
            </div>
            {stepRec && (
              <div className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]" style={{ borderColor: REC, background: 'rgba(239,68,68,0.08)' }}>
                <span className="font-semibold" style={{ color: REC }}>
                  STEP REC
                </span>
                <span className="text-muted">
                  step {stepRec.cursor + 1} ·{' '}
                  {stepRec.root === null ? 'play a key — the first one is the root' : `root ${midiNoteName(stepRec.root)} (hold it to hear the line as played)`}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {(
                    [
                      ['back', 'Back', 'Move back one step'],
                      ['rest', 'Rest', 'Leave this step empty and move on'],
                      ['tie', 'Tie', 'Hold the previous note through this step'],
                      ['clear', 'Clear', 'Empty all steps and start over at step 1'],
                    ] as const
                  ).map(([k, label, title]) => (
                    <button key={k} type="button" title={title} onClick={() => recEdit(k)} className="flex h-6 items-center gap-0.5 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2">
                      {k === 'back' && <ChevronLeft size={12} />}
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <StepGrid
              cfg={cfg}
              setStep={setStep}
              velDrag={velDrag}
              trackId={trackId}
              onSteps={(fn) => {
                const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
                set({ steps: fn(cur.steps) }, 'melody');
              }}
              onScale={(s) => set({ scale: s }, 'scale')}
              recCursor={stepRec?.cursor ?? null}
              onPickRecStep={(i) => {
                const next = { cursor: i, root: stepRecRef.current?.root ?? null };
                stepRecRef.current = next;
                setStepRec(next);
              }}
            />
          </div>
        )}
        {!seq && liveRec && <div className="text-[11px]" style={{ color: REC }}>{recStatus === 'countIn' ? 'Counting in…' : 'Recording'} — hold keys; they go into a clip on this track and play back through the arp. Click Rec (or Space) to stop. Bake to notes turns it into the actual notes.</div>}
        {!on && <div className="text-[11px] text-warn">Arp-Ape-ator is off — keys play normally. Switch it on to hear the pattern.</div>}
      </div>

      <KeyboardStrip trackId={trackId} kb={kb} low={36} high={84} flashColor={CYAN} />
    </div>
    {/* the gorilla on the window's top edge, drumming on the frame */}
    <ArpApe x={pos.x + WIN_W - 290 - APE_W / 2} y={pos.y + 1 - APE_RAIL_Y} hits={apeHits} z={win.z} />
    </>
  );
}

const ROW = 'grid gap-[3px]';
function StepGrid({
  cfg,
  setStep,
  velDrag,
  recCursor,
  onPickRecStep,
  trackId,
  onSteps,
  onScale,
}: {
  trackId: string;
  onSteps: (fn: (steps: SeqStep[]) => SeqStep[]) => void;
  onScale: (s: ArpScale) => void;
  cfg: ArpConfig;
  setStep: (i: number, part: Partial<SeqStep>, key: string) => void;
  velDrag: React.MutableRefObject<number | null>;
  /** step recording: the step the next key fills (a click moves it there instead of toggling) */
  recCursor: number | null;
  onPickRecStep: (i: number) => void;
}) {
  const cols = { gridTemplateColumns: `64px repeat(${SEQ_STEPS}, minmax(0, 1fr))` };
  const rowLabel = (t: string, title: string) => (
    <div className="flex items-center text-[9px] uppercase tracking-wider text-muted" title={title}>
      {t}
    </div>
  );
  const flag = (key: 'accent' | 'slide' | 'tie', i: number, s: SeqStep, color: string, title: string) => (
    <button
      key={key + i}
      type="button"
      title={title}
      disabled={!s.on || i >= cfg.length}
      onClick={() => setStep(i, { [key]: !s[key] } as Partial<SeqStep>, key)}
      className="h-4 rounded disabled:opacity-20"
      style={{ background: s[key] && s.on ? color : 'var(--color-panel-3, #22222e)' }}
    />
  );
  const velAt = (e: React.PointerEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const v = Math.min(1, Math.max(0.05, 1 - (e.clientY - r.top) / r.height));
    setStep(i, { vel: Math.round(v * 100) / 100 }, 'vel');
  };
  return (
    <div className="flex flex-col gap-[3px] rounded-md border border-line bg-panel-2 p-2">
      <div className={ROW} style={cols}>
        {rowLabel('Step', 'Click to turn steps on / off')}
        {cfg.steps.map((s, i) => (
          <button
            key={i}
            type="button"
            data-step={i}
            data-on={s.on ? '1' : '0'}
            onClick={() => (recCursor !== null ? onPickRecStep(i) : setStep(i, { on: !s.on }, 'on'))}
            className={`relative h-8 rounded text-[10px] font-semibold ${i >= cfg.length ? 'opacity-25' : ''} ${i % 4 === 0 ? 'ring-1 ring-line-2' : ''}`}
            style={{
              outline: recCursor === i ? `2px solid ${REC}` : undefined,
              outlineOffset: 1,
              background: s.on ? CYAN : 'var(--color-panel-3, #22222e)',
              color: s.on ? '#000' : 'var(--color-dim, #666)',
            }}
          >
            <span data-playhead className="pointer-events-none absolute inset-0 rounded bg-white" style={{ opacity: 0 }} />
            <span data-flash className="pointer-events-none absolute inset-0 rounded" style={{ background: FLASH, opacity: 0, boxShadow: `0 0 12px ${FLASH}` }} />
            <span className="relative">{i + 1}</span>
          </button>
        ))}
      </div>
      <PitchLane trackId={trackId} cfg={cfg} cols={cols} onSteps={onSteps} onScale={onScale} />
      <div className={ROW} style={cols}>
        {rowLabel('Velocity', 'Drag up / down')}
        {cfg.steps.map((s, i) => (
          <div
            key={i}
            className={`relative h-10 cursor-ns-resize rounded bg-base ${!s.on || i >= cfg.length ? 'opacity-25' : ''}`}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              velDrag.current = i;
              velAt(e, i);
            }}
            onPointerMove={(e) => velDrag.current === i && velAt(e, i)}
            onPointerUp={() => (velDrag.current = null)}
          >
            <div className="absolute bottom-0 left-0 right-0 rounded" style={{ height: `${s.vel * 100}%`, background: s.accent ? '#f472b6' : CYAN, opacity: 0.8 }} />
          </div>
        ))}
      </div>
      <div className={ROW} style={cols}>
        {rowLabel('Accent', 'Louder hit')}
        {cfg.steps.map((s, i) => flag('accent', i, s, '#f472b6', 'Accent: louder'))}
      </div>
      <div className={ROW} style={cols}>
        {rowLabel('Slide', 'Glides into the next step (808, Acid and other mono sounds)')}
        {cfg.steps.map((s, i) => flag('slide', i, s, '#fb923c', 'Slide: overlap into the next step so mono synths glide'))}
      </div>
      <div className={ROW} style={cols}>
        {rowLabel('Tie', 'Joins this step with the next into one long note')}
        {cfg.steps.map((s, i) => flag('tie', i, s, '#a78bfa', 'Tie: one long note with the next step'))}
      </div>
      <div className={ROW} style={cols}>
        {rowLabel('Roll', 'Repeats inside the step (click: 1 → 2 → 3 → 4)')}
        {cfg.steps.map((s, i) => (
          <button
            key={i}
            type="button"
            disabled={!s.on || i >= cfg.length}
            onClick={() => setStep(i, { ratchet: (s.ratchet % 4) + 1 }, 'rat')}
            className="h-5 rounded bg-panel-3 text-[10px] text-fg disabled:opacity-20"
            title="Roll: 1–4 hits inside the step (trap hat rolls)"
          >
            {s.ratchet > 1 ? `×${s.ratchet}` : '·'}
          </button>
        ))}
      </div>
      <div className={ROW} style={cols}>
        {rowLabel('Chance', 'How often the step plays (click: 100 → 75 → 50 → 25 %)')}
        {cfg.steps.map((s, i) => (
          <button
            key={i}
            type="button"
            disabled={!s.on || i >= cfg.length}
            onClick={() => setStep(i, { prob: s.prob <= 0.26 ? 1 : Math.round((s.prob - 0.25) * 100) / 100 }, 'prob')}
            className="h-5 rounded bg-panel-3 text-[10px] text-fg disabled:opacity-20"
            title="Chance: how often this step plays (the same every playback)"
          >
            {s.prob >= 1 ? '·' : `${Math.round(s.prob * 100)}%`}
          </button>
        ))}
      </div>
    </div>
  );
}
