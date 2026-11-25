import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FilePlus2, FolderOpen, HardDrive, Loader2, Package, Save, Trash2, Upload, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { exportRange, type ExportRangeMode } from '../../audio/exportPlan';
import { renderProjectToWav, type ExportResult } from '../../audio/exportRender';
import type { WavFormat } from '../../audio/wav';
import { formatSeconds } from '../../core/time';
import { storageEstimate, type ProjectMeta } from '../../persistence/db';
import { downloadBlob, safeFileName } from '../../persistence/download';
import {
  deleteProject,
  duplicateProject,
  exportArchive,
  importArchive,
  listProjects,
  newProject,
  openProject,
  saveNow,
  usePersistStore,
} from '../../persistence/session';
import { getProject, useProjectStore } from '../../state/projectStore';
import { uiToast } from '../../state/uiStore';
import { IconButton } from '../common/controls';

type Dialog = 'none' | 'browser' | 'export';
let openDialog: (d: Dialog) => void = () => {};

export function openExportDialog(): void {
  openDialog('export');
}

/** Save button + status, the project (File) menu, and the dialogs it opens. */
export function ProjectControls() {
  const status = usePersistStore((s) => s.status);
  const lastSavedAt = usePersistStore((s) => s.lastSavedAt);
  const error = usePersistStore((s) => s.error);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>('none');
  const importInput = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  openDialog = setDialog;

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setMenu(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [menu]);

  const statusText =
    status === 'saving' ? 'Saving…' : status === 'dirty' ? 'Unsaved changes' : status === 'saved' ? `Saved${lastSavedAt ? ' ' + new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}` : status === 'unavailable' ? 'Not saved — storage unavailable' : status === 'error' ? 'Save failed' : '…';
  const item = (icon: React.ReactNode, label: string, onClick: () => void, hint?: string) => (
    <button
      type="button"
      onClick={() => {
        setMenu(false);
        onClick();
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-accent/25"
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && <span className="font-mono text-[10px] text-muted">{hint}</span>}
    </button>
  );

  return (
    <div ref={wrap} className="relative flex items-center gap-1">
      <IconButton title="Project: new, open, copy, archives, export" onClick={() => setMenu((m) => !m)} active={menu}>
        <FolderOpen size={14} />
      </IconButton>
      <IconButton title={`Save now (Ctrl+S) — ${statusText}${error ? `: ${error}` : ''}. Changes are also saved automatically.`} onClick={() => void saveNow()}>
        <Save size={14} />
      </IconButton>
      <span
        className={`w-[92px] truncate text-[10px] ${status === 'error' || status === 'unavailable' ? 'text-bad' : status === 'dirty' || status === 'saving' ? 'text-warn' : 'text-muted'}`}
        title={error ?? statusText}
      >
        {statusText}
      </span>
      {menu && (
        <div className="absolute left-0 top-9 z-[90] w-[250px] rounded-md border border-line-2 bg-panel-2 py-1 shadow-2xl shadow-black/60">
          {item(<FilePlus2 size={13} />, 'New project', () => void newProject())}
          {item(<FolderOpen size={13} />, 'Open project…', () => setDialog('browser'))}
          {item(<Copy size={13} />, 'Save a copy and open it', () => void duplicateProject(getProject().id, true))}
          <div className="my-1 h-px bg-line" />
          {item(<Package size={13} />, 'Export project archive (.phasr)', () => void exportArchive())}
          {item(<Upload size={13} />, 'Import project archive…', () => importInput.current?.click())}
          <div className="my-1 h-px bg-line" />
          {item(<Download size={13} />, 'Export WAV…', () => setDialog('export'))}
        </div>
      )}
      <input
        ref={importInput}
        type="file"
        accept=".phasr,.zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importArchive(f);
        }}
      />
      {dialog === 'browser' && <ProjectBrowser onClose={() => setDialog('none')} onImport={() => importInput.current?.click()} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog('none')} />}
    </div>
  );
}

function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ width }} className="max-h-[80vh] overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70">
        <div className="flex h-10 items-center border-b border-line bg-panel-2 px-3">
          <span className="text-[13px] font-semibold text-fg">{title}</span>
          <button type="button" onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg" title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProjectBrowser({ onClose, onImport }: { onClose: () => void; onImport: () => void }) {
  const currentId = useProjectStore((s) => s.project.id);
  const backend = usePersistStore((s) => s.backend);
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [usage, setUsage] = useState<string>('');
  const refresh = () => {
    void listProjects().then(setList);
    void storageEstimate().then((e) => e && setUsage(`${(e.usage / 1e6).toFixed(1)} MB used of ${(e.quota / 1e9).toFixed(1)} GB`));
  };
  useEffect(refresh, []);
  return (
    <Modal title="Projects" onClose={onClose} width={640}>
      <div className="max-h-[56vh] overflow-y-auto">
        {list === null && <div className="p-4 text-muted">Loading…</div>}
        {list?.length === 0 && <div className="p-4 text-muted">No saved projects yet.</div>}
        {list?.map((p) => (
          <div key={p.id} className={`flex items-center gap-3 border-b border-line px-3 py-2 ${p.id === currentId ? 'bg-accent/10' : ''}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-fg">
                {p.name} {p.id === currentId && <span className="ml-1 rounded bg-accent px-1 text-[9px] text-white">OPEN</span>}
              </div>
              <div className="text-[10px] text-muted">
                {new Date(p.updatedAt).toLocaleString()} · {p.trackCount} tracks · {p.clipCount} clips · {p.assetIds.length} audio files
              </div>
            </div>
            <button
              type="button"
              disabled={p.id === currentId}
              onClick={() => void openProject(p.id).then((ok) => ok && onClose())}
              className="h-6 rounded bg-accent px-2 text-[11px] text-white disabled:opacity-30"
            >
              Open
            </button>
            <button type="button" title="Duplicate" onClick={() => void duplicateProject(p.id).then(refresh)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
              <Copy size={12} />
            </button>
            <button type="button" title="Export archive (.phasr)" onClick={() => void exportArchive(p.id)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
              <Package size={12} />
            </button>
            <button
              type="button"
              title={p.id === currentId ? 'Open another project to delete this one' : 'Delete permanently'}
              disabled={p.id === currentId}
              onClick={() => {
                if (confirm(`Delete “${p.name}” permanently? Its audio files are removed too unless another project uses them. This can’t be undone.`)) void deleteProject(p.id).then(refresh);
              }}
              className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 text-muted hover:bg-line-2 hover:text-bad disabled:opacity-30"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-panel-2 px-3 py-2 text-[10px] text-muted">
        <HardDrive size={12} /> {backend === 'opfs' ? 'Audio in Origin Private File System' : backend === 'indexeddb' ? 'Audio in IndexedDB' : 'Storage unavailable'} {usage && `· ${usage}`}
        <button type="button" onClick={onImport} className="ml-auto flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2">
          <Upload size={12} /> Import archive…
        </button>
        <button type="button" onClick={() => void newProject().then(onClose)} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2">
          <FilePlus2 size={12} /> New
        </button>
      </div>
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const [range, setRange] = useState<ExportRangeMode>(project.loop.enabled ? 'loop' : 'song');
  const [sr, setSr] = useState(engine.ctx?.sampleRate === 48000 ? 48000 : 44100);
  const [format, setFormat] = useState<WavFormat>('pcm16');
  const [tail, setTail] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  let rangeText = '';
  let rangeOk = true;
  try {
    const r = exportRange(project, range);
    rangeText = `${formatSeconds(r.seconds)} (${((r.endTick - r.startTick) / 3840).toFixed(1)} bars)`;
  } catch (e) {
    rangeOk = false;
    rangeText = e instanceof Error ? e.message : String(e);
  }
  const run = async () => {
    setResult(null);
    setProgress(0);
    try {
      const res = await renderProjectToWav(getProject(), engine.assets, { sampleRate: sr, range, tail, format, onProgress: setProgress });
      setResult(res);
      const ok = res.verified.header && res.verified.length && res.verified.finite;
      if (!ok) uiToast('error', 'The rendered file failed verification and was not downloaded.');
      else downloadBlob(new Blob([res.wav], { type: 'audio/wav' }), `${safeFileName(getProject().name)}${range === 'loop' ? ' (loop)' : ''}.wav`);
    } catch (e) {
      uiToast('error', `Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
    }
  };
  const busy = progress !== null;
  const row = 'flex items-center justify-between gap-3 py-1.5';
  return (
    <Modal title="Export WAV" onClose={() => !busy && onClose()} width={440}>
      <div className="flex flex-col p-3 text-[12px]">
        <div className={row}>
          <span className="text-muted">Range</span>
          <select value={range} onChange={(e) => setRange(e.target.value as ExportRangeMode)} disabled={busy}>
            <option value="song">Whole arrangement</option>
            <option value="loop">Loop region</option>
          </select>
        </div>
        <div className={`-mt-1 pb-1 text-right text-[10px] ${rangeOk ? 'text-dim' : 'text-bad'}`}>{rangeText}</div>
        <div className={row}>
          <span className="text-muted">Sample rate</span>
          <select value={sr} onChange={(e) => setSr(Number(e.target.value))} disabled={busy}>
            {[44100, 48000, 88200, 96000].map((r) => (
              <option key={r} value={r}>
                {(r / 1000).toFixed(1)} kHz
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="text-muted">Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as WavFormat)} disabled={busy}>
            <option value="pcm16">16-bit PCM (dithered)</option>
            <option value="float32">32-bit float</option>
          </select>
        </div>
        <label className={`${row} cursor-pointer`}>
          <span className="text-muted">Include release &amp; effect tails</span>
          <input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)} disabled={busy} />
        </label>
        <div className="py-1 text-[10px] text-dim">Mute and solo are respected. The metronome is never exported. Rendering runs offline (faster than realtime) through the same instruments, effects, automation and sidechains you hear.</div>
        {busy && (
          <div className="mt-2">
            <div className="h-2 overflow-hidden rounded bg-base">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted">
              <Loader2 size={11} className="animate-spin" /> Rendering… {Math.round((progress ?? 0) * 100)}%
            </div>
          </div>
        )}
        {result && (
          <div className="mt-2 rounded border border-line bg-base/50 p-2 text-[11px] text-fg">
            <div className="mb-1 flex items-center gap-1 font-semibold">
              <Check size={12} className="text-ok" /> Exported {formatSeconds(result.durationSec)} · {(result.sampleRate / 1000).toFixed(1)} kHz · stereo
            </div>
            <div className="text-[10px] text-muted">
              Range {formatSeconds(result.rangeSec)} + tail {result.tailSec.toFixed(2)} s · {result.frames.toLocaleString()} frames · peak {Number.isFinite(result.peakDb) ? `${result.peakDb.toFixed(1)} dBFS` : 'silent'} · {(result.wav.byteLength / 1e6).toFixed(1)} MB
            </div>
            <div className="text-[10px] text-muted">
              Verified: header {result.verified.header ? '✓' : '✗'} · length {result.verified.length ? '✓' : '✗'} · samples {result.verified.finite ? '✓' : '✗'}
            </div>
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="h-7 rounded bg-panel-3 px-3 text-[12px] hover:bg-line-2 disabled:opacity-40">
            Close
          </button>
          <button type="button" onClick={() => void run()} disabled={busy || !rangeOk} className="flex h-7 items-center gap-1 rounded bg-accent px-3 text-[12px] text-white hover:bg-accent-hi disabled:opacity-40">
            <Download size={13} /> Export
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Full-screen blocker while a project opens/imports. */
export function BusyOverlay() {
  const busy = usePersistStore((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50">
      <div className="flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-4 py-3 text-[12px] text-fg shadow-2xl">
        <Loader2 size={14} className="animate-spin" /> {busy}
      </div>
    </div>
  );
}
