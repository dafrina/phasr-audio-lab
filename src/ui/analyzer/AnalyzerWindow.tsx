/**
 * Analyser window for one channel (the master, a send or a track; opened from
 * the mixer): a spectrum, a scrolling spectrogram and a triggered oscilloscope.
 *
 * Cost rules: everything is drawn on canvas (no per-frame SVG or React
 * renders); a view's AnalyserNode is fed from the channel only while that view
 * is on screen and the page is visible (closed, switched off, scrolled away or
 * a hidden tab = no analysis and no drawing); frames that would look the same
 * (silence) are skipped; per-frame work reuses its buffers.
 */
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Activity, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { EFFECT_LABELS } from '../../audio/effects/specs';
import { MASTER_ID, SEND_IDS, sendLabel, type SendBus } from '../../project/types';
import { useProjectStore } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';
import { isFrontWindow, useWindowZ } from '../common/windowStack';
import { cellPeaks, findTrigger, freqToUnit, logBinRanges, peakOf, spectrogramPalette } from './analysis';
import { analyzerStats, type AnalyzerView } from './stats';

const WIN_W = 560;
const ACCENT = '#38bdf8';
const BG = '#0b0b12';
const GRID = '#1d1d2c';
const VIEWS: { id: AnalyzerView; label: string; title: string; h: number }[] = [
  { id: 'spectrum', label: 'Spectrum', title: 'Level per frequency (log scale, 20 Hz – 20 kHz)', h: 150 },
  { id: 'spectrogram', label: 'Spectrogram', title: 'Frequency over time: scrolls right to left, brighter = louder', h: 150 },
  { id: 'scope', label: 'Scope', title: 'Waveform (20 ms), triggered on a rising zero crossing so a steady tone stands still', h: 120 },
];
const FREQ_MARKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const fmtHz = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

function usePageVisible(): boolean {
  const [v, setV] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

interface Frame {
  a: AnalyserNode;
  g: CanvasRenderingContext2D;
  /** canvas size in device pixels */
  w: number;
  h: number;
  dpr: number;
  /** the canvas was just (re)sized (and so cleared) */
  resized: boolean;
}

/**
 * A canvas whose `draw` runs once per animation frame while it is on screen and
 * the page is visible, with an AnalyserNode fed from the channel for exactly
 * that time. `draw` returns whether it drew anything.
 */
function useAnalyserCanvas(trackId: string, view: AnalyzerView, opts: AnalyserOptions, draw: (f: Frame) => boolean, fps = 60) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pageVisible = usePageVisible();
  const audioReady = useUiStore((s) => s.audioReady);
  const [onScreen, setOnScreen] = useState(true);
  const size = useRef({ w: 0, h: 0 });
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setOnScreen(es.some((e) => e.isIntersecting)));
    io.observe(el);
    const ro = new ResizeObserver(() => (size.current = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    size.current = { w: el.clientWidth, h: el.clientHeight };
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);
  const visible = pageVisible && onScreen;
  const { fftSize, smoothingTimeConstant, minDecibels, maxDecibels } = opts;
  useEffect(() => {
    const ctx = engine.ctx;
    const el = canvas.current;
    if (!visible || !ctx || !el) return;
    const g = el.getContext('2d', { alpha: false });
    if (!g) return;
    const a = new AnalyserNode(ctx, { fftSize, smoothingTimeConstant, minDecibels, maxDecibels });
    engine.addAnalyser(trackId, a);
    let raf = 0;
    let w = 0;
    let h = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // views that don't need every display frame draw less often (main-thread time)
      if (now - last < 1000 / fps - 4) return;
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.max(1, Math.round(size.current.w * dpr));
      const ch = Math.max(1, Math.round(size.current.h * dpr));
      const resized = cw !== w || ch !== h;
      if (resized) {
        el.width = w = cw;
        el.height = h = ch;
        g.fillStyle = BG;
        g.fillRect(0, 0, w, h);
      }
      analyzerStats.frames[view]++;
      if (drawRef.current({ a, g, w, h, dpr, resized })) analyzerStats.draws[view]++;
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      engine.removeAnalyser(trackId, a);
    };
  }, [visible, audioReady, trackId, view, fftSize, smoothingTimeConstant, minDecibels, maxDecibels, fps]);
  return canvas;
}

/** the frequency grid behind the spectrum, drawn once per size */
function spectrumGrid(w: number, h: number, dpr: number, minDb: number, maxDb: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = GRID;
  g.lineWidth = 1;
  g.fillStyle = '#55557a';
  g.font = `${9 * dpr}px Inter, system-ui, sans-serif`;
  for (const f of FREQ_MARKS) {
    const x = Math.round(freqToUnit(f) * w) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    g.fillText(fmtHz(f), x + 3 * dpr, h - 3 * dpr);
  }
  for (let db = maxDb - 20; db > minDb; db -= 20) {
    const y = Math.round(((maxDb - db) / (maxDb - minDb)) * h) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.fillText(`${db}`, 3 * dpr, y - 2 * dpr);
  }
  return c;
}

/** displayed range, dBFS */
const SPEC_MIN = -96;
const SPEC_MAX = 0;
/**
 * Chrome's AnalyserNode reads a full-scale sine at −13.56 dB (its FFT is scaled
 * by 1/N and Blackman-windowed: ½ × 0.42); adding this makes it read 0 dBFS
 * (measured, any FFT size).
 */
const FFT_CAL_DB = 13.56;

function SpectrumView({ trackId }: { trackId: string }) {
  const st = useRef<{ data: Float32Array<ArrayBuffer> | null; ranges: Int32Array | null; peaks: Float32Array | null; bg: HTMLCanvasElement | null; silent: boolean }>({ data: null, ranges: null, peaks: null, bg: null, silent: false });
  const canvas = useAnalyserCanvas(trackId, 'spectrum', { fftSize: 8192, smoothingTimeConstant: 0.75, minDecibels: SPEC_MIN - FFT_CAL_DB, maxDecibels: SPEC_MAX - FFT_CAL_DB }, ({ a, g, w, h, dpr, resized }) => {
    const s = st.current;
    const bins = a.frequencyBinCount;
    if (s.data?.length !== bins) s.data = new Float32Array(bins);
    const cells = Math.max(16, Math.floor(w / (2 * dpr)));
    if (s.ranges?.length !== cells + 1) {
      s.ranges = logBinRanges(cells, bins, a.context.sampleRate);
      s.peaks = new Float32Array(cells);
    }
    const peaks = s.peaks as Float32Array;
    a.getFloatFrequencyData(s.data);
    cellPeaks(s.data, s.ranges, peaks);
    let loud = false;
    for (let i = 0; i < cells; i++) if ((peaks[i] as number) + FFT_CAL_DB > SPEC_MIN + 1) loud = true;
    if (!loud && s.silent && !resized) return false;
    s.silent = !loud;
    if (s.bg?.width !== w || s.bg.height !== h) s.bg = spectrumGrid(w, h, dpr, SPEC_MIN, SPEC_MAX);
    g.drawImage(s.bg, 0, 0);
    const y = (raw: number) => ((Math.max(SPEC_MIN, Math.min(SPEC_MAX, raw + FFT_CAL_DB)) - SPEC_MAX) / (SPEC_MIN - SPEC_MAX)) * h;
    g.beginPath();
    g.moveTo(0, h);
    for (let c = 0; c < cells; c++) g.lineTo(((c + 0.5) / cells) * w, y(peaks[c] as number));
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = 'rgba(56,189,248,0.18)';
    g.fill();
    g.strokeStyle = ACCENT;
    g.lineWidth = 1.25 * dpr;
    g.stroke();
    return true;
  }, 30);
  return <canvas ref={canvas} data-testid="analyzer-spectrum" className="block h-full w-full" />;
}

function SpectrogramView({ trackId }: { trackId: string }) {
  const st = useRef<{ bytes: Uint8Array<ArrayBuffer> | null; ranges: Int32Array | null; rows: Uint8Array | null; col: ImageData | null; col32: Uint32Array | null; silent: boolean; palette: Uint32Array }>({ bytes: null, ranges: null, rows: null, col: null, col32: null, silent: false, palette: spectrogramPalette() });
  // colours span −96 … −6 dBFS (calibrated like the spectrum)
  const canvas = useAnalyserCanvas(trackId, 'spectrogram', { fftSize: 4096, smoothingTimeConstant: 0, minDecibels: -96 - FFT_CAL_DB, maxDecibels: -6 - FFT_CAL_DB }, ({ a, g, w, h, resized }) => {
    const s = st.current;
    const bins = a.frequencyBinCount;
    if (s.bytes?.length !== bins) s.bytes = new Uint8Array(bins);
    if (resized || s.ranges?.length !== h + 1) {
      s.ranges = logBinRanges(h, bins, a.context.sampleRate);
      s.rows = new Uint8Array(h);
      s.col = g.createImageData(1, h);
      s.col32 = new Uint32Array(s.col.data.buffer);
    }
    const rows = s.rows as Uint8Array;
    const col32 = s.col32 as Uint32Array;
    a.getByteFrequencyData(s.bytes);
    cellPeaks(s.bytes, s.ranges, rows);
    let loud = false;
    for (let i = 0; i < h; i++) if ((rows[i] as number) > 0) loud = true;
    // silence: one dark column, then stand still until there is sound again
    if (!loud && s.silent) return false;
    s.silent = !loud;
    // scroll one pixel left, paint the newest column at the right edge (low frequencies at the bottom)
    g.drawImage(g.canvas, -1, 0);
    for (let y = 0; y < h; y++) col32[y] = s.palette[rows[h - 1 - y] as number] as number;
    g.putImageData(s.col as ImageData, w - 1, 0);
    return true;
  });
  return (
    <div className="relative h-full w-full">
      <canvas ref={canvas} data-testid="analyzer-spectrogram" className="block h-full w-full" />
      {/* frequency labels: static, so they don't scroll with the image */}
      {FREQ_MARKS.filter((f) => f !== 50 && f !== 200 && f !== 2000).map((f) => (
        <span key={f} className="pointer-events-none absolute left-1 font-mono text-[9px] text-white/50" style={{ bottom: `calc(${freqToUnit(f) * 100}% - 6px)` }}>
          {fmtHz(f)}
        </span>
      ))}
    </div>
  );
}

function ScopeView({ trackId }: { trackId: string }) {
  // range: auto, follows the signal's peak (fast up, slowly down) so quiet channels fill the view too
  const st = useRef<{ buf: Float32Array<ArrayBuffer> | null; bg: HTMLCanvasElement | null; silent: boolean; range: number; at: number; label: string }>({ buf: null, bg: null, silent: false, range: 0, at: 0, label: '' });
  const rangeLabel = useRef<HTMLSpanElement>(null);
  const canvas = useAnalyserCanvas(trackId, 'scope', { fftSize: 4096, smoothingTimeConstant: 0, minDecibels: -100, maxDecibels: -30 }, ({ a, g, w, h, dpr, resized }) => {
    const s = st.current;
    const n = a.fftSize;
    if (s.buf?.length !== n) s.buf = new Float32Array(n);
    const buf = s.buf;
    a.getFloatTimeDomainData(buf);
    const pk = peakOf(buf);
    if (pk < 1e-5 && s.silent && !resized) return false;
    s.silent = pk < 1e-5;
    if (s.bg?.width !== w || s.bg.height !== h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const bg = c.getContext('2d') as CanvasRenderingContext2D;
      bg.fillStyle = BG;
      bg.fillRect(0, 0, w, h);
      bg.strokeStyle = GRID;
      for (const v of [-0.5, 0, 0.5]) {
        const yy = Math.round(h / 2 - v * h * 0.45) + 0.5;
        bg.beginPath();
        bg.moveTo(0, yy);
        bg.lineTo(w, yy);
        bg.stroke();
      }
      s.bg = c;
    }
    g.drawImage(s.bg, 0, 0);
    // the range jumps up to a new peak and falls back by 12 dB per second (whatever the frame rate)
    const now = performance.now();
    const fall = Math.pow(0.25, Math.min(1, (now - s.at) / 1000));
    s.at = now;
    const range = Math.min(1, Math.max(0.01, pk, s.range * fall));
    s.range = range;
    const text = `±${range >= 0.1 ? range.toFixed(2) : range.toFixed(3)}`;
    if (text !== s.label && rangeLabel.current) {
      s.label = text;
      rangeLabel.current.textContent = text;
    }
    // 20 ms from the trigger (free-running when nothing triggers)
    const win = Math.min(n >> 1, Math.round(a.context.sampleRate * 0.02));
    let start = findTrigger(buf, 0, n - win, Math.max(1e-4, 0.05 * pk));
    if (start < 0) start = n - win;
    const y = (v: number) => h / 2 - Math.max(-1.1, Math.min(1.1, v / s.range)) * h * 0.45;
    g.strokeStyle = '#4ade80';
    g.lineWidth = 1.25 * dpr;
    g.beginPath();
    const spp = win / w;
    if (spp > 3) {
      // several samples per pixel: a min-max line per column (no peaks lost between pixels)
      for (let x = 0; x < w; x++) {
        const i0 = start + Math.floor(x * spp);
        const i1 = start + Math.floor((x + 1) * spp);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = i0; i < i1; i++) {
          const v = buf[i] as number;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (x === 0) g.moveTo(x + 0.5, y(hi));
        g.lineTo(x + 0.5, y(hi));
        g.lineTo(x + 0.5, y(lo));
      }
    } else {
      for (let i = 0; i <= win; i++) {
        const x = (i / win) * w;
        const v = buf[start + i] as number;
        if (i === 0) g.moveTo(x, y(v));
        else g.lineTo(x, y(v));
      }
    }
    g.stroke();
    return true;
  }, 30);
  return (
    <div className="relative h-full w-full">
      <canvas ref={canvas} data-testid="analyzer-scope" className="block h-full w-full" />
      <span ref={rangeLabel} title="Vertical range (auto: follows the signal's peak; ±1 = full scale)" className="pointer-events-none absolute bottom-1 left-1.5 font-mono text-[9px] text-white/40" />
    </div>
  );
}

const VIEW_COMPONENTS: Record<AnalyzerView, ComponentType<{ trackId: string }>> = {
  spectrum: SpectrumView,
  spectrogram: SpectrogramView,
  scope: ScopeView,
};

export function AnalyzerWindow({ trackId }: { trackId: string }) {
  const win = useWindowZ('analyzer');
  const tracks = useProjectStore((s) => s.project.tracks);
  const sends = useProjectStore((s) => s.project.sends);
  const setUi = useUiStore((s) => s.set);
  const [shown, setShown] = useState<Record<AnalyzerView, boolean>>({ spectrum: true, spectrogram: true, scope: true });
  const [pos, setPos] = useState(() => ({ x: Math.max(8, window.innerWidth - WIN_W - 24), y: 64 }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const close = useCallback(() => setUi({ analyzerTrackId: null }), [setUi]);
  const isSend = (SEND_IDS as readonly string[]).includes(trackId);
  const track = tracks.find((t) => t.id === trackId);
  const exists = trackId === MASTER_ID || isSend || !!track;
  useEffect(() => {
    if (!exists) close();
  }, [exists, close]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFrontWindow('analyzer')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  if (!exists) return null;
  const busName = (bus: SendBus | undefined) => (bus ? sendLabel(bus, (t) => EFFECT_LABELS[t], true) : 'Send');
  const name = trackId === MASTER_ID ? 'Master' : track ? track.name : busName(sends?.[(SEND_IDS as readonly string[]).indexOf(trackId)]);
  return (
    <div
      data-testid="analyzer"
      onPointerDownCapture={win.raise}
      style={{ left: pos.x, top: pos.y, width: WIN_W, zIndex: win.z }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70"
    >
      <div
        className="flex h-9 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-[#10202c] to-panel px-3"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input')) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          dragWin.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragWin.current;
          if (d) setPos({ x: Math.min(window.innerWidth - 120, Math.max(-400, e.clientX - d.dx)), y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)) });
        }}
        onPointerUp={() => (dragWin.current = null)}
      >
        <Activity size={15} style={{ color: ACCENT }} />
        <span className="text-[13px] font-bold tracking-[0.14em]" style={{ color: ACCENT }}>
          ANALYZER
        </span>
        <select
          value={trackId}
          onChange={(e) => setUi({ analyzerTrackId: e.target.value })}
          title="Which channel to analyse (post fader: what its meter shows)"
          className="h-6 max-w-[150px] rounded border border-line bg-base px-1 text-[11px] text-fg"
        >
          <option value={MASTER_ID}>Master</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {SEND_IDS.map((id, k) => (
            <option key={id} value={id}>
              Send {busName(sends?.[k])}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              title={`${shown[v.id] ? 'Hide' : 'Show'} the ${v.label.toLowerCase()}: ${v.title}`}
              aria-pressed={shown[v.id]}
              onClick={() => setShown((s) => ({ ...s, [v.id]: !s[v.id] }))}
              className={`h-6 rounded px-2 text-[11px] ${shown[v.id] ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
              style={shown[v.id] ? { background: ACCENT } : undefined}
            >
              {v.label}
            </button>
          ))}
          <button type="button" title="Close (Esc)" onClick={close} className="ml-1 flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-2">
        {VIEWS.filter((v) => shown[v.id]).map((v) => {
          const View = VIEW_COMPONENTS[v.id];
          return (
            <div key={v.id} className="relative overflow-hidden rounded border border-line" style={{ height: v.h }} title={v.title}>
              <View trackId={trackId} />
              <span className="pointer-events-none absolute right-1.5 top-1 text-[9px] uppercase tracking-wider text-white/40">{v.label}</span>
            </div>
          );
        })}
        {!VIEWS.some((v) => shown[v.id]) && <div className="p-4 text-center text-[11px] text-muted">No view selected.</div>}
        <div className="text-[10px] text-dim">
          {name}, post fader. Analysis runs only while a view is on screen{trackId === MASTER_ID ? '; the master is measured after its effects, fader and safety limiter' : ''}.
        </div>
      </div>
    </div>
  );
}
