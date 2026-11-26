/**
 * Arp-Ape-ator: an arpeggiator and a 16-step sequencer in front of any
 * instrument. Hold keys (computer keyboard, MIDI, the keybed below, or long
 * notes in a clip) and they play the pattern, locked to the song grid.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Power, Repeat2, Wand2, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { ARP_DIRECTIONS, ARP_PRESETS, ARP_RATES, SEQ_STEPS, arpPreset, defaultArp, type ArpConfig, type SeqStep } from '../../arp/arp';
import { arpActive, bakeArp } from '../../arp/expand';
import { getProject, updateTrack, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { ArpApe } from './ArpApe';
import { KeyboardStrip, useComputerKeyboard } from '../synth/KeyboardStrip';
import type { NumericParamSpec } from '../../synth/params';
import { PPQ } from '../../core/time';

const WIN_W = 940;
const CYAN = '#22d3ee';
const GATE: NumericParamSpec = { label: 'Gate', min: 0.05, max: 1, default: 0.6, curve: 'linear', format: (v) => `${Math.round(v * 100)}%` };
const SWING: NumericParamSpec = { label: 'Swing', min: 0, max: 0.75, default: 0, curve: 'linear', format: (v) => `${Math.round(v * 100)}%` };

/** Create the tool on a track (if needed) and open its window. */
export function openArp(trackId: string): void {
  const t = getProject().tracks.find((x) => x.id === trackId);
  if (!t || t.kind !== 'instrument') return;
  if (!t.arp) updateTrack(trackId, { arp: defaultArp() }, 'Add Arp-Ape-ator');
  useUiStore.getState().set({ arpTrackId: trackId });
}

export function ArpWindow({ trackId }: { trackId: string }) {
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const clipCount = useProjectStore((s) => Object.values(s.project.clips).filter((c) => c.trackId === trackId && c.kind === 'midi').length);
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 600) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const velDrag = useRef<number | null>(null);
  const [playStep, setPlayStep] = useState(-1);

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    setUi({ arpTrackId: null });
  }, [trackId, setUi]);
  const kb = useComputerKeyboard(trackId, close, 0.85);

  useEffect(() => {
    if (!track || track.kind !== 'instrument' || !track.arp) setUi({ arpTrackId: null });
  }, [track, setUi]);
  useEffect(() => root.current?.focus(), [trackId]);

  // the playing step (while the song runs)
  const cfgRef = useRef<ArpConfig | null>(null);
  cfgRef.current = track?.arp ?? null;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = engine.transport;
      const c = cfgRef.current;
      if (!t || !c || !t.isPlaying()) {
        setPlayStep((s) => (s === -1 ? s : -1));
        return;
      }
      const st = Math.max(1, Math.round(c.rate * PPQ));
      const len = Math.max(1, c.length);
      const s = Math.floor(t.getTick() / st) % len;
      setPlayStep((p) => (p === s ? p : s));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!track || !track.arp) return null;
  const cfg = track.arp;
  const on = arpActive(track);
  const seq = cfg.mode === 'seq';

  const set = (part: Partial<ArpConfig>, key: string) => {
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    updateTrack(trackId, { arp: { ...cur, ...part, presetName: part.presetName ?? (key === 'enabled' || key === 'latch' ? cur.presetName : 'Custom') } }, 'Edit Arp-Ape-ator', { coalesce: `arp-${trackId}-${key}` });
  };
  const setStep = (i: number, part: Partial<SeqStep>, key: string) => {
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    set({ steps: cur.steps.map((s, j) => (j === i ? { ...s, ...part } : s)) }, `${key}-${i}`);
  };
  const loadPreset = (name: string) => {
    const p = arpPreset(name);
    if (!p) return;
    const cur = getProject().tracks.find((t) => t.id === trackId)?.arp ?? cfg;
    updateTrack(trackId, { arp: { ...structuredClone(p), enabled: cur.enabled, latch: cur.latch } }, `Arp-Ape-ator: ${name}`);
  };

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
      style={{ left: pos.x, top: pos.y, width: WIN_W }}
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
            <StepGrid cfg={cfg} playStep={playStep} setStep={setStep} velDrag={velDrag} />
          </div>
        )}
        {!on && <div className="text-[11px] text-warn">Arp-Ape-ator is off — keys play normally. Switch it on to hear the pattern.</div>}
      </div>

      <KeyboardStrip trackId={trackId} kb={kb} low={36} high={84} />
    </div>
    {/* the gorilla on the window's top edge, drumming on the frame */}
    <ArpApe x={pos.x + WIN_W - 360} y={pos.y - 110} trackId={trackId} />
    </>
  );
}

const ROW = 'grid gap-[3px]';
function StepGrid({ cfg, playStep, setStep, velDrag }: { cfg: ArpConfig; playStep: number; setStep: (i: number, part: Partial<SeqStep>, key: string) => void; velDrag: React.MutableRefObject<number | null> }) {
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
            onClick={() => setStep(i, { on: !s.on }, 'on')}
            className={`h-8 rounded text-[10px] font-semibold ${i >= cfg.length ? 'opacity-25' : ''} ${i % 4 === 0 ? 'ring-1 ring-line-2' : ''}`}
            style={{
              background: s.on ? (i === playStep ? '#ffffff' : CYAN) : i === playStep ? '#3a4a52' : 'var(--color-panel-3, #22222e)',
              color: s.on ? '#000' : 'var(--color-dim, #666)',
            }}
          >
            {i + 1}
          </button>
        ))}
      </div>
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
      <div className={ROW} style={cols}>
        {rowLabel('Pitch', 'Semitones above / below the held key (wheel or click ±)')}
        {cfg.steps.map((s, i) => (
          <div
            key={i}
            className={`flex h-6 select-none flex-col items-center justify-center rounded bg-panel-3 text-[10px] ${!s.on || i >= cfg.length ? 'opacity-20' : 'text-fg'}`}
            title="Pitch: semitones from the held key — scroll, or click the top / bottom half"
            onWheel={(e) => s.on && setStep(i, { transpose: Math.max(-24, Math.min(24, s.transpose + (e.deltaY < 0 ? 1 : -1))) }, 'tr')}
            onClick={(e) => {
              if (!s.on) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setStep(i, { transpose: Math.max(-24, Math.min(24, s.transpose + (e.clientY < r.top + r.height / 2 ? 1 : -1))) }, 'tr');
            }}
          >
            {s.transpose > 0 ? `+${s.transpose}` : s.transpose}
          </div>
        ))}
      </div>
    </div>
  );
}
