/**
 * Capture: a toolbar button (and Ctrl/Cmd+K) that turns what you just played
 * into a MIDI clip, plus a popover to extend how far back it reaches (bar by
 * bar, up to the buffer's minute) with a live preview of what it would take.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { captureNow, maxCaptureBars, planCapture, type CapturePlan } from '../../audio/captureLive';
import { ticksPerBar } from '../../core/time';
import { getProject } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';
import { IconButton } from '../common/controls';

export function CaptureControls() {
  const bars = useUiStore((s) => s.captureBars);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  return (
    <div ref={wrap} className="relative flex items-center">
      <IconButton
        data-testid="capture"
        title={`Capture (Ctrl/Cmd+K): turn the last ${bars} bar${bars === 1 ? '' : 's'} you played on an instrument into a MIDI clip — no need to have been recording`}
        onClick={() => captureNow(bars)}
        className="rounded-r-none"
      >
        <History size={14} />
      </IconButton>
      <IconButton data-testid="capture-settings" title="Capture: how far back, and a preview" size="md" onClick={() => setOpen((o) => !o)} active={open} className="!min-w-4 rounded-l-none !px-0.5">
        <ChevronDown size={11} />
      </IconButton>
      {open && <CapturePanel onDone={() => setOpen(false)} />}
    </div>
  );
}

function CapturePanel({ onDone }: { onDone: () => void }) {
  const bars = useUiStore((s) => s.captureBars);
  const set = useUiStore((s) => s.set);
  const [plan, setPlan] = useState<CapturePlan | null>(() => planCapture(bars));
  const canvas = useRef<HTMLCanvasElement>(null);
  const max = maxCaptureBars();
  // the preview follows what you play while the panel is open
  useEffect(() => {
    setPlan(planCapture(bars));
    const t = setInterval(() => setPlan(planCapture(bars)), 250);
    return () => clearInterval(t);
  }, [bars]);
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const w = c.width;
    const h = c.height;
    g.fillStyle = '#0c0c13';
    g.fillRect(0, 0, w, h);
    if (!plan) return;
    const { notes, length } = plan.result;
    const bar = ticksPerBar(getProject().timeSignature);
    g.strokeStyle = '#26263a';
    for (let t = bar; t < length; t += bar) {
      const x = Math.round((t / length) * w) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    const lo = Math.min(...notes.map((n) => n.pitch)) - 1;
    const hi = Math.max(...notes.map((n) => n.pitch)) + 1;
    const rowH = Math.max(2, Math.min(8, h / (hi - lo + 1)));
    for (const n of notes) {
      const y = h - ((n.pitch - lo + 0.5) / (hi - lo + 1)) * h - rowH / 2;
      g.fillStyle = `rgba(167,139,250,${0.45 + (n.velocity / 127) * 0.55})`;
      g.fillRect((n.start / length) * w, y, Math.max(2, (n.length / length) * w - 1), rowH - 1);
    }
  }, [plan]);
  const secs = (b: number) => {
    const p = getProject();
    return (b * ticksPerBar(p.timeSignature) * 60) / (960 * p.bpm);
  };
  const setBars = (b: number) => set({ captureBars: Math.min(max, Math.max(1, b)) });
  const r = plan?.result;
  const barTicks = ticksPerBar(getProject().timeSignature);
  return (
    <div data-testid="capture-panel" className="absolute left-0 top-9 z-[90] w-[320px] rounded-md border border-line-2 bg-panel-2 p-3 text-[11px] shadow-2xl shadow-black/60">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        <History size={12} /> Capture
      </div>
      <div className="mb-2 text-dim">The last minute of notes played on every instrument track is kept, recording or not. Capture turns the last bars of it into a clip.</div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted">Last</span>
        <button type="button" title="One bar less" onClick={() => setBars(bars - 1)} disabled={bars <= 1} className="h-6 w-6 rounded bg-panel-3 hover:bg-line-2 disabled:opacity-40">
          −
        </button>
        <span data-testid="capture-bars" className="w-14 text-center font-mono text-fg">
          {bars} bar{bars === 1 ? '' : 's'}
        </span>
        <button type="button" title="One bar more (back in time)" onClick={() => setBars(bars + 1)} disabled={bars >= max} className="h-6 w-6 rounded bg-panel-3 hover:bg-line-2 disabled:opacity-40">
          +
        </button>
        <span className="text-dim">≈ {secs(bars).toFixed(1)} s (max {max})</span>
      </div>
      <canvas ref={canvas} width={296} height={70} className="mb-1.5 block w-full rounded border border-line" />
      <div data-testid="capture-preview" className="mb-2 min-h-[28px] text-dim">
        {r && plan
          ? `${r.notes.length} note${r.notes.length === 1 ? '' : 's'} · ${Math.round(r.length / barTicks)} bar${r.length === barTicks ? '' : 's'} · ${plan.trackName} · ${
              r.mode === 'timeline' ? `where you played them (bar ${Math.floor(plan.start / barTicks) + 1})` : `timing kept, placed at bar ${Math.floor(plan.start / barTicks) + 1}`
            }${r.held ? ` · ${r.held} key${r.held === 1 ? '' : 's'} still held` : ''}`
          : 'Nothing played yet: play an instrument track (keyboard, MIDI, pads) and it shows up here.'}
      </div>
      <button
        type="button"
        disabled={!plan}
        onClick={() => {
          if (captureNow(bars)) onDone();
        }}
        className="h-7 w-full rounded bg-accent font-semibold text-white disabled:opacity-40"
      >
        Capture
      </button>
    </div>
  );
}
