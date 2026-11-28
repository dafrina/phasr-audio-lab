/**
 * Sampler window: drop samples, see how they cover the keyboard (keys left
 * to right, velocity bottom to top), adjust zones, play.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Play, Trash2, Upload, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { createId } from '../../core/ids';
import { midiNoteName } from '../../core/time';
import { SAMPLER_SPECS } from '../../instruments/definitions';
import type { InstrumentConfig } from '../../project/types';
import { auditionVelocity, detectPitch, loudnessDb, mapZones, noteFromName, uncoveredKeys, type SamplerParams, type SamplerZone } from '../../sampler/zones';
import { useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { AutoKnob } from '../common/AutoKnob';
import { Meter } from '../common/Meter';
import { KeyboardStrip, useComputerKeyboard } from '../synth/KeyboardStrip';
import { useWindowZ } from '../common/windowStack';

type SamplerConfig = Extract<InstrumentConfig, { type: 'sampler' }>;

const WIN_W = 980;
const LOW = 21;
const HIGH = 108;
const COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#c084fc'];

function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff)$/i.test(f.name);
}

function commitConfig(trackId: string, label: string, fn: (c: SamplerConfig) => SamplerConfig, coalesce?: string, assets?: Record<string, import('../../project/types').AssetRef>): void {
  useProjectStore.getState().commit(
    label,
    (p) => ({
      ...p,
      assets: assets ? { ...p.assets, ...assets } : p.assets,
      tracks: p.tracks.map((t) => (t.id === trackId && t.instrument?.type === 'sampler' ? { ...t, instrument: fn(t.instrument) } : t)),
    }),
    coalesce ? { coalesce } : {},
  );
}

export function SamplerWindow({ trackId }: { trackId: string }) {
  const win = useWindowZ('sampler');
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 660) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    setUi({ synthTrackId: null });
  }, [trackId, setUi]);
  const kb = useComputerKeyboard(trackId, close, 0.8, 'sampler');

  useEffect(() => {
    if (!track || track.instrument?.type !== 'sampler') setUi({ synthTrackId: null });
  }, [track, setUi]);
  useEffect(() => {
    root.current?.focus();
  }, [trackId]);

  const cfg = track?.instrument?.type === 'sampler' ? track.instrument : null;
  const mapped = useMemo(() => (cfg ? mapZones(cfg) : []), [cfg]);
  if (!track || !cfg) return null;

  const zoneColor = (z: SamplerZone) => COLORS[[...new Set(cfg.zones.map((x) => x.root))].sort((a, b) => a - b).indexOf(z.root) % COLORS.length] ?? '#38bdf8';
  const selected = cfg.zones.find((z) => z.id === sel) ?? null;
  const gaps = cfg.autoMap ? [] : uncoveredKeys(mapped).filter((n) => n >= LOW && n <= HIGH);

  const addFiles = async (files: File[]) => {
    const audio = files.filter(isAudioFile);
    if (!audio.length) return uiToast('error', 'Drop audio files (wav, mp3, ogg, flac, aiff …).');
    setBusy(true);
    const zones: SamplerZone[] = [];
    const assets: Record<string, import('../../project/types').AssetRef> = {};
    const guessed: string[] = [];
    for (const f of audio) {
      try {
        const a = await engine.importAudioFile(f);
        const data = a.buffer.getChannelData(0);
        let rootNote = noteFromName(f.name);
        if (rootNote === null) {
          const p = detectPitch(data, a.buffer.sampleRate);
          if (p && p.confidence > 0.5) rootNote = Math.round(p.midi);
          else {
            rootNote = 60;
            guessed.push(f.name);
          }
        }
        assets[a.ref.id] = a.ref;
        zones.push({ id: createId('z'), assetId: a.ref.id, name: a.ref.name.slice(0, 60), root: Math.max(0, Math.min(127, rootNote)), lo: 0, hi: 127, velLo: 1, velHi: 127, tune: 0, gain: 0, loudness: loudnessDb(data, a.buffer.sampleRate) });
      } catch (e) {
        uiToast('error', e instanceof Error ? e.message : `Could not load ${f.name}`);
      }
    }
    setBusy(false);
    if (!zones.length) return;
    commitConfig(
      trackId,
      `Add ${zones.length} sample${zones.length === 1 ? '' : 's'}`,
      (c) => {
        // manual mode: new zones start on their root key (and spread later by the user)
        const added = c.autoMap ? zones : zones.map((z) => ({ ...z, lo: z.root, hi: z.root }));
        return { ...c, zones: [...c.zones, ...added], presetName: c.zones.length ? c.presetName : (zones.length === 1 ? (zones[0]?.name ?? 'Bank') : `Bank (${zones.length} samples)`) };
      },
      undefined,
      assets,
    );
    setSel(zones[zones.length - 1]?.id ?? null);
    uiToast('info', `Added ${zones.length} sample${zones.length === 1 ? '' : 's'}: ${zones.map((z) => `${z.name} → ${midiNoteName(z.root)}`).join(', ')}`);
    if (guessed.length) uiToast('info', `No note found for ${guessed.join(', ')} — set to C4. Change the root below if needed.`);
  };

  const setZone = (id: string, part: Partial<SamplerZone>, key: string) =>
    commitConfig(trackId, 'Edit sampler zone', (c) => ({ ...c, zones: c.zones.map((z) => (z.id === id ? { ...z, ...part } : z)) }), `smp-${trackId}-${id}-${key}`);
  const removeZone = (id: string) => {
    commitConfig(trackId, 'Remove sample', (c) => ({ ...c, zones: c.zones.filter((z) => z.id !== id) }));
    if (sel === id) setSel(null);
  };
  const setParam = (key: keyof SamplerParams, v: number) =>
    commitConfig(trackId, 'Edit sampler', (c) => ({ ...c, params: { ...c.params, [key]: v } }), `smp-${trackId}-${key}`);
  const toggleAuto = () =>
    commitConfig(trackId, cfg.autoMap ? 'Manual mapping' : 'Auto mapping', (c) => {
      if (!c.autoMap) return { ...c, autoMap: true };
      // switching to manual keeps the current automatic layout as the starting point
      const m = mapZones(c);
      return { ...c, autoMap: false, zones: c.zones.map((z) => { const e = m.find((x) => x.id === z.id); return e ? { ...z, lo: e.keyLo, hi: e.keyHi, velLo: e.vLo, velHi: e.vHi } : z; }) };
    });
  const audition = (z: SamplerZone) => {
    // at a velocity inside the sample's own layer (a fixed loud one would always pick the loudest layer)
    const id = engine.previewNoteOn(trackId, z.root - Math.round(cfg.params.transpose), auditionVelocity(cfg, z.id), performance.now(), true);
    if (id !== null) setTimeout(() => engine.previewNoteOff(trackId, id), 700);
  };

  const keyW = 100 / (HIGH - LOW + 1);
  const knob = (k: keyof SamplerParams) => (
    <AutoKnob key={k} trackId={trackId} target={{ kind: 'inst', param: k }} spec={SAMPLER_SPECS[k]} value={cfg.params[k]} color="#38bdf8" onChange={(v) => setParam(k, v)} />
  );

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-testid="sampler-window"
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addFiles([...e.dataTransfer.files]);
      }}
      onPointerDownCapture={win.raise}
      style={{ left: pos.x, top: pos.y, width: WIN_W, zIndex: win.z }}
      className={`fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-panel shadow-2xl shadow-black/70 outline-none ${dragOver ? 'border-sky-400' : 'border-line-2'}`}
    >
      <div
        className="touch-control flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-panel-3 to-panel px-3"
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
        <span className="h-3.5 w-1 -skew-x-[20deg] bg-sky-400" />
        <span className="text-[14px] font-bold tracking-[0.18em] text-fg">SAMPLER</span>
        <span className="text-[10px] uppercase tracking-wider text-muted">· {track.name}</span>
        <input
          value={cfg.presetName}
          onChange={(e) => commitConfig(trackId, 'Rename bank', (c) => ({ ...c, presetName: e.target.value.slice(0, 40) }), `smp-${trackId}-name`)}
          className="ml-3 h-6 w-48 rounded border border-line bg-base px-1.5 text-[11px] text-fg outline-none"
          title="Bank name"
        />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className="flex h-6 items-center gap-1 rounded bg-sky-500 px-2 text-[11px] font-semibold text-black hover:bg-sky-400 disabled:opacity-50">
          <FolderOpen size={12} /> {busy ? 'Loading…' : 'Add samples…'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void addFiles(files);
          }}
        />
        <button
          type="button"
          onClick={toggleAuto}
          title={cfg.autoMap ? 'Auto: key ranges split between root notes, same-root samples become velocity layers. Click for manual ranges.' : 'Manual: you set key/velocity ranges; uncovered keys use the nearest sample. Click for automatic mapping.'}
          className={`h-6 rounded px-2 text-[11px] ${cfg.autoMap ? 'bg-sky-500/20 text-sky-300' : 'bg-panel-3 text-muted'}`}
        >
          Mapping: {cfg.autoMap ? 'Auto' : 'Manual'}
        </button>
        <button type="button" title="Close (Esc)" onClick={close} className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
          <X size={14} />
        </button>
      </div>

      {/* key / velocity map */}
      <div className="px-3 pt-2">
        <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted">
          <span>Key map — keys left → right, velocity bottom → top</span>
          <span className="normal-case tracking-normal text-dim">
            {cfg.zones.length} sample{cfg.zones.length === 1 ? '' : 's'}
            {gaps.length ? ` · ${gaps.length} keys borrow the nearest sample` : cfg.zones.length ? ' · every key covered' : ''}
          </span>
        </div>
        <div className="relative h-[92px] overflow-hidden rounded border border-line bg-base" data-testid="sampler-map">
          {Array.from({ length: Math.ceil((HIGH - LOW + 1) / 12) + 1 }, (_, i) => {
            const n = 24 + i * 12;
            if (n < LOW || n > HIGH) return null;
            return (
              <div key={n} className="absolute bottom-0 top-0 border-l border-line/60" style={{ left: `${(n - LOW) * keyW}%` }}>
                <span className="absolute bottom-0.5 left-0.5 text-[8px] text-dim">{midiNoteName(n)}</span>
              </div>
            );
          })}
          {gaps.map((n) => (
            <div key={`g${n}`} className="absolute bottom-0 top-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(255,255,255,0.05)_3px,rgba(255,255,255,0.05)_6px)]" style={{ left: `${(n - LOW) * keyW}%`, width: `${keyW}%` }} />
          ))}
          {mapped.map((z) => {
            const lo = Math.max(LOW, z.keyLo);
            const hi = Math.min(HIGH, z.keyHi);
            if (hi < lo) return null;
            const c = zoneColor(z);
            const isSel = z.id === sel;
            return (
              <button
                key={z.id}
                type="button"
                title={`${z.name}: root ${midiNoteName(z.root)}, keys ${midiNoteName(z.keyLo)}–${midiNoteName(z.keyHi)}, velocity ${z.vLo}–${z.vHi}`}
                onClick={() => setSel(z.id)}
                className="absolute overflow-hidden rounded-sm border text-left text-[9px] leading-tight"
                style={{
                  left: `${(lo - LOW) * keyW}%`,
                  width: `${(hi - lo + 1) * keyW}%`,
                  top: `${((127 - z.vHi) / 127) * 100}%`,
                  height: `${((z.vHi - z.vLo + 1) / 127) * 100}%`,
                  background: `${c}${isSel ? '66' : '33'}`,
                  borderColor: isSel ? '#fff' : `${c}aa`,
                  color: '#e8f4ff',
                }}
              >
                <span className="px-0.5">{z.name}</span>
              </button>
            );
          })}
          {mapped.map((z) =>
            z.root >= LOW && z.root <= HIGH ? <div key={`r${z.id}`} className="pointer-events-none absolute bottom-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-white" style={{ left: `${(z.root - LOW + 0.5) * keyW}%` }} title={`root ${midiNoteName(z.root)}`} /> : null,
          )}
          {!cfg.zones.length && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[11px] text-muted">
              <Upload size={18} className="text-sky-400" />
              Drop one or more samples here (or use “Add samples…”).
              <span className="text-[10px] text-dim">Notes come from file names like “Piano_C4.wav” or pitch detection. One sample is enough — every key gets pitched from the nearest sample.</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 gap-2 p-3">
        {/* zones */}
        <div className="max-h-[170px] min-w-0 flex-1 overflow-auto rounded border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-panel-2 text-[9px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-1.5 py-1 text-left">Sample</th>
                <th className="px-1 text-left">Root</th>
                {!cfg.autoMap && <th className="px-1 text-left">Keys</th>}
                {!cfg.autoMap && <th className="px-1 text-left">Velocity</th>}
                <th className="px-1 text-left">Tune</th>
                <th className="px-1 text-left">Gain</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cfg.zones.map((z) => {
                const m = mapped.find((x) => x.id === z.id);
                const noteSel = (value: number, onChange: (n: number) => void, title: string) => (
                  <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-5 w-[62px]" title={title}>
                    {Array.from({ length: 128 }, (_, n) => (
                      <option key={n} value={n}>
                        {midiNoteName(n)}
                      </option>
                    ))}
                  </select>
                );
                const num = (value: number, min: number, max: number, onChange: (v: number) => void, title: string) => (
                  <input type="number" value={Math.round(value * 10) / 10} min={min} max={max} title={title} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} className="h-5 w-12 rounded border border-line bg-base px-1 text-right font-mono text-[10px] text-fg outline-none" />
                );
                return (
                  <tr key={z.id} onClick={() => setSel(z.id)} className={`cursor-default border-t border-line/60 ${z.id === sel ? 'bg-sky-500/10' : ''}`}>
                    <td className="max-w-[220px] truncate px-1.5 py-0.5" title={z.name}>
                      <span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: zoneColor(z) }} />
                      {z.name}
                      {cfg.autoMap && m && <span className="ml-1 text-[9px] text-dim">{midiNoteName(m.keyLo)}–{midiNoteName(m.keyHi)}{m.vLo > 1 || m.vHi < 127 ? ` · v${m.vLo}–${m.vHi}` : ''}</span>}
                    </td>
                    <td className="px-1">{noteSel(z.root, (n) => setZone(z.id, { root: n }, 'root'), 'The note this sample was recorded at')}</td>
                    {!cfg.autoMap && (
                      <td className="whitespace-nowrap px-1">
                        {noteSel(z.lo, (n) => setZone(z.id, { lo: Math.min(n, z.hi) }, 'lo'), 'Lowest key')}–{noteSel(z.hi, (n) => setZone(z.id, { hi: Math.max(n, z.lo) }, 'hi'), 'Highest key')}
                      </td>
                    )}
                    {!cfg.autoMap && (
                      <td className="whitespace-nowrap px-1">
                        {num(z.velLo, 1, 127, (v) => setZone(z.id, { velLo: Math.min(Math.round(v), z.velHi) }, 'vlo'), 'Lowest velocity')}–{num(z.velHi, 1, 127, (v) => setZone(z.id, { velHi: Math.max(Math.round(v), z.velLo) }, 'vhi'), 'Highest velocity')}
                      </td>
                    )}
                    <td className="px-1">{num(z.tune, -100, 100, (v) => setZone(z.id, { tune: v }, 'tune'), 'Fine tune (cents)')}</td>
                    <td className="px-1">{num(z.gain, -48, 12, (v) => setZone(z.id, { gain: v }, 'gain'), 'Gain (dB)')}</td>
                    <td className="whitespace-nowrap px-1 text-right">
                      <button type="button" title="Play this sample at its root" onClick={() => audition(z)} className="mr-0.5 inline-flex h-5 w-5 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
                        <Play size={10} />
                      </button>
                      <button type="button" title="Remove this sample" onClick={() => removeZone(z.id)} className="inline-flex h-5 w-5 items-center justify-center rounded bg-panel-3 text-muted hover:text-bad">
                        <Trash2 size={10} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!cfg.zones.length && (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-center text-[11px] text-dim">
                    No samples yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* playback */}
        <div className="flex shrink-0 flex-col gap-1.5 rounded border border-line bg-panel-2 p-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Playback</div>
          <div className="flex items-end gap-1.5">
            {knob('attack')}
            {knob('release')}
            {knob('velSens')}
            {knob('transpose')}
            {knob('gain')}
            <Meter source={trackId} width={8} height={44} />
          </div>
          <button
            type="button"
            onClick={() => setParam('oneShot', cfg.params.oneShot ? 0 : 1)}
            title="One-shot: samples play to their end, releasing a key doesn't stop them (drums, hits, FX)"
            className={`h-6 rounded px-2 text-[11px] ${cfg.params.oneShot ? 'bg-sky-500 font-semibold text-black' : 'bg-panel-3 text-muted'}`}
          >
            One-shot {cfg.params.oneShot ? 'on' : 'off'}
          </button>
          {selected && <div className="max-w-[260px] truncate text-[10px] text-dim">Selected: {selected.name}</div>}
        </div>
      </div>

      <KeyboardStrip trackId={trackId} kb={kb} low={36} high={96} />
    </div>
  );
}
