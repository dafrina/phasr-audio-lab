import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Circle, Mic, RefreshCw } from 'lucide-react';
import { recorder } from '../../audio/recorder';
import { updateProjectFields, useProjectStore } from '../../state/projectStore';
import { useRecordingStore } from '../../state/recordingStore';
import { useTransportStore } from '../../state/transportStore';
import { IconButton } from '../common/controls';
import { Meter } from '../common/Meter';

/** Record button plus a settings popover (input device, count-in, latency, input level). */
export function RecordControls() {
  const status = useRecordingStore((s) => s.status);
  const armedTrackId = useRecordingStore((s) => s.armedTrackId);
  const engineStatus = useTransportStore((s) => s.engineStatus);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const recording = status === 'recording' || status === 'countIn' || status === 'finishing';

  useEffect(() => {
    if (!open) return;
    void recorder.refreshDevices();
    const close = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  const title =
    status === 'countIn'
      ? 'Counting in… (click or R to cancel)'
      : status === 'recording'
        ? 'Recording — click or press R to stop'
        : armedTrackId
          ? 'Record onto the armed track (R)'
          : 'Record (R) — arm an audio track first, or select one';

  return (
    <div ref={wrap} className="relative flex items-center">
      <IconButton
        title={title}
        disabled={engineStatus !== 'ready' || status === 'finishing' || status === 'opening'}
        active={recording}
        activeClass={`bg-bad text-white ${status === 'countIn' ? 'animate-pulse' : ''}`}
        onClick={() => void recorder.toggleRecord()}
        className="rounded-r-none"
      >
        <Circle size={13} fill="currentColor" className={recording ? 'text-white' : 'text-bad'} />
      </IconButton>
      <IconButton title="Recording settings: input device, count-in, latency" size="md" onClick={() => setOpen((o) => !o)} active={open} className="!min-w-4 rounded-l-none !px-0.5">
        <ChevronDown size={11} />
      </IconButton>
      {open && <RecordPanel />}
    </div>
  );
}

function RecordPanel() {
  const { status, inputs, deviceId, armedTrackId, autoLatencyMs, manualOffsetMs, inputLabel, error } = useRecordingStore();
  const countIn = useProjectStore((s) => s.project.countInBars);
  const armedName = useProjectStore((s) => s.project.tracks.find((t) => t.id === armedTrackId)?.name);
  const inputOpen = status !== 'idle' && status !== 'opening';
  return (
    <div className="absolute left-0 top-9 z-[90] w-[300px] rounded-md border border-line-2 bg-panel-2 p-3 text-[11px] shadow-2xl shadow-black/60">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        <Mic size={12} /> Recording
      </div>
      <label className="mb-1 block text-muted">Input device</label>
      <div className="mb-2 flex gap-1">
        <select value={deviceId} onChange={(e) => void recorder.selectDevice(e.target.value)} className="h-6 min-w-0 flex-1" disabled={status === 'recording' || status === 'countIn'}>
          <option value="">System default</option>
          {inputs
            .filter((d) => d.deviceId && d.deviceId !== 'default')
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
        </select>
        <button type="button" title="Refresh device list" onClick={() => void recorder.refreshDevices()} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
          <RefreshCw size={11} />
        </button>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <Meter source="input" orientation="horizontal" width={180} height={9} showPeak />
        {inputOpen ? (
          <button type="button" onClick={() => recorder.closeInput()} className="h-5 rounded bg-panel-3 px-1.5 text-[10px] text-muted hover:text-fg" disabled={status === 'recording' || status === 'countIn'}>
            Close input
          </button>
        ) : (
          <button type="button" onClick={() => void recorder.openInput()} className="h-5 rounded bg-accent px-1.5 text-[10px] text-white">
            Open input
          </button>
        )}
      </div>
      <div className="mb-2 text-dim">
        {inputOpen ? `Input: ${inputLabel ?? '—'}` : 'Input closed (opens when you arm a track)'} · Armed: {armedName ?? 'none'}
      </div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted">Count-in</span>
        <select value={countIn} onChange={(e) => updateProjectFields('Count-in', { countInBars: Number(e.target.value) })} className="h-6">
          {[0, 1, 2, 4].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Off' : `${n} bar${n > 1 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-muted" title="Output + input latency reported by the browser; recordings are shifted earlier by this amount">
          Latency (auto)
        </span>
        <span className="font-mono text-fg">{inputOpen ? `${autoLatencyMs} ms` : '—'}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted" title="Extra correction if recordings still sound late (+) or early (−)">
          Manual offset
        </span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            value={manualOffsetMs}
            step={1}
            min={-500}
            max={500}
            onChange={(e) => recorder.setManualOffset(Number(e.target.value) || 0)}
            className="h-6 w-16 rounded border border-line bg-base px-1 text-right font-mono text-fg outline-none"
          />
          <span className="text-dim">ms</span>
        </span>
      </div>
      <div className="mt-2 text-[10px] leading-snug text-dim">Use headphones when monitoring (I) to avoid feedback. Takes never overwrite existing clips.</div>
      {error && <div className="mt-2 rounded border border-bad/50 bg-bad/10 px-2 py-1 text-[10px] text-fg">{error}</div>}
    </div>
  );
}
