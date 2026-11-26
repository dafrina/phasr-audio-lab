import { useEffect, useRef, useState } from 'react';
import { Power } from 'lucide-react';
import { engine } from '../../audio/engine';
import {
  PEQ_BAND_COLORS,
  PEQ_SLOPES,
  PEQ_SPECS,
  PEQ_TYPE_LABELS,
  PEQ_TYPES,
  peqHasGain,
  peqHasQ,
} from '../../audio/effects/specs';
import { automatedKeys, valueAt } from '../../project/automation';
import type { EffectSlot, PeqBand, PeqBandType, PeqSlope } from '../../project/types';
import type { PeqBandOffset } from '../../audio/effects/units';
import { automate, writeAutomation, endAutomationGesture } from '../../state/automationActions';
import { setEffectParams } from '../../state/effectActions';
import { getProject } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';
import { AutoKnob } from '../common/AutoKnob';
import { ContextMenu, type MenuItem } from '../common/ContextMenu';

type PeqSlot = Extract<EffectSlot, { type: 'peq' }>;

const W = 600;
const H = 160;
const DB_RANGE = 24;
const F_MIN = 20;
const F_MAX = 20000;
const N_POINTS = 300;
const NODE_R = 7;

const fToX = (f: number) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * W;
const xToF = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / W)));
const dbToY = (db: number) => H / 2 - (db / DB_RANGE) * (H / 2 - 10);
const yToDb = (y: number) => ((H / 2 - y) / (H / 2 - 10)) * DB_RANGE;
const clampF = (f: number) => Math.min(F_MAX, Math.max(F_MIN, f));
const clampDb = (d: number) => Math.min(DB_RANGE, Math.max(-DB_RANGE, d));

const FREQS = (() => {
  const a = new Float32Array(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) a[i] = xToF((i / (N_POINTS - 1)) * W);
  return a;
})();

function liveSlot(trackId: string, slotId: string): PeqSlot | null {
  const s = getProject().tracks.find((t) => t.id === trackId)?.effects.find((e) => e.id === slotId);
  return s && s.type === 'peq' ? s : null;
}

/** What the sidechain routes on this EQ are doing right now, per band (dB / cents / Q). */
function liveOffsets(trackId: string, slotId: string): Map<number, PeqBandOffset> {
  const out = new Map<number, PeqBandOffset>();
  const track = getProject().tracks.find((t) => t.id === trackId);
  const mod = engine.modulation;
  if (!track || !mod) return out;
  for (const r of track.modulations) {
    if (!r.enabled || r.target.kind !== 'fx' || r.target.slotId !== slotId) continue;
    const m = /^b(\d)\.(freq|gain|q)$/.exec(r.target.param);
    if (!m) continue;
    const amount = r.depth * mod.level(r.id);
    if (Math.abs(amount) < 1e-4) continue;
    const i = Number(m[1]);
    const o = out.get(i) ?? {};
    if (m[2] === 'gain') o.gain = (o.gain ?? 0) + amount;
    else if (m[2] === 'freq') o.cents = (o.cents ?? 0) + amount * 100;
    else o.q = (o.q ?? 0) + amount;
    out.set(i, o);
  }
  return out;
}

/** Band values as heard right now (automation curves applied at the playhead). */
function effectiveBand(trackId: string, slot: PeqSlot, i: number): PeqBand {
  const band = slot.params.bands[i] as PeqBand;
  const track = getProject().tracks.find((t) => t.id === trackId);
  if (!track) return band;
  const tick = engine.transport?.getTick() ?? 0;
  const out = { ...band };
  for (const l of track.automation) {
    if (!l.enabled || l.target.kind !== 'fx' || l.target.slotId !== slot.id) continue;
    const m = /^b(\d)\.(freq|gain|q)$/.exec(l.target.param);
    if (!m || Number(m[1]) !== i) continue;
    const v = valueAt(l.points, tick);
    if (v !== null) out[m[2] as 'freq' | 'gain' | 'q'] = v;
  }
  return out;
}

export function PeqDevice({ trackId, slot, color }: { trackId: string; slot: PeqSlot; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const selected = useUiStore((s) => s.peqSelected[slot.id] ?? -1);
  const setUi = useUiStore((s) => s.set);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const drag = useRef<{ band: number; x: number; y: number; f: number; g: number; key: string } | null>(null);
  const hover = useRef<number>(-1);

  const select = (i: number) => setUi({ peqSelected: { ...useUiStore.getState().peqSelected, [slot.id]: i } });

  /** Update a band. Automated fields write automation at the playhead; the rest change the static value. */
  const setBand = (i: number, part: Partial<PeqBand>, key: string) => {
    const s = liveSlot(trackId, slot.id);
    const track = getProject().tracks.find((t) => t.id === trackId);
    if (!s || !track) return;
    const auto = automatedKeys(track, slot.id);
    const staticPart: Partial<PeqBand> = {};
    for (const [k, v] of Object.entries(part) as [keyof PeqBand, PeqBand[keyof PeqBand]][]) {
      const autoKey = `b${i}.${k}`;
      if ((k === 'freq' || k === 'gain' || k === 'q') && auto.has(autoKey)) {
        writeAutomation(trackId, { kind: 'fx', slotId: slot.id, param: autoKey }, v as number, `${key}-${k}`);
      } else {
        (staticPart as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(staticPart).length === 0) return;
    const bands = s.params.bands.map((b, j) => (j === i ? { ...b, ...staticPart } : b));
    setEffectParams(trackId, slot.id, { bands }, `peq-${slot.id}-${key}`);
  };

  const addBandAt = (x: number, y: number) => {
    const s = liveSlot(trackId, slot.id);
    if (!s) return;
    const i = s.params.bands.findIndex((b) => !b.enabled);
    if (i < 0) return;
    const f = clampF(xToF(x));
    const type: PeqBandType = f < 35 ? 'lowcut' : f > 15000 ? 'highcut' : 'bell';
    setBand(i, { enabled: true, type, freq: f, gain: type === 'bell' ? Math.round(clampDb(yToDb(y)) * 2) / 2 : 0, q: type === 'bell' ? 1 : 0.707, slope: 24 }, `add${i}`);
    select(i);
  };

  const hitNode = (x: number, y: number): number => {
    const s = liveSlot(trackId, slot.id);
    if (!s) return -1;
    let best = -1;
    let bestD = NODE_R + 4;
    s.params.bands.forEach((_, i) => {
      const b = effectiveBand(trackId, s, i);
      if (!b.enabled) return;
      const nx = fToX(b.freq);
      const ny = dbToY(peqHasGain(b.type) ? b.gain : 0);
      const d = Math.hypot(nx - x, ny - y) - (i === selected ? 2 : 0);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  // ---- drawing ----
  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mag = new Float32Array(N_POINTS);
    const bandMag = new Float32Array(N_POINTS);
    let spec: Float32Array<ArrayBuffer> | null = null;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = liveSlot(trackId, slot.id);
      if (!s) return;
      const unit = engine.peqUnit(trackId, slot.id);
      const sel = useUiStore.getState().peqSelected[slot.id] ?? -1;
      g.fillStyle = '#08080d';
      g.fillRect(0, 0, W, H);
      // grid
      g.font = '9px ui-monospace, Menlo, monospace';
      g.textBaseline = 'top';
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        const x = Math.round(fToX(f)) + 0.5;
        g.fillStyle = f === 100 || f === 1000 || f === 10000 ? '#1f1f30' : '#15151f';
        g.fillRect(x, 0, 1, H);
        g.fillStyle = '#4a4a62';
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 11);
      }
      for (const d of [-18, -12, -6, 0, 6, 12, 18]) {
        const y = Math.round(dbToY(d)) + 0.5;
        g.fillStyle = d === 0 ? '#2a2a40' : '#15151f';
        g.fillRect(0, y, W, 1);
        g.fillStyle = '#4a4a62';
        g.fillText(`${d > 0 ? '+' : ''}${d}`, 3, y + 1);
      }
      // live spectrum (post-EQ)
      const an = unit?.analyser;
      if (an) {
        if (!spec || spec.length !== an.frequencyBinCount) spec = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(spec);
        const binHz = engine.ctx ? engine.ctx.sampleRate / an.fftSize : 23.4;
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W; x += 2) {
          const f = xToF(x);
          const bin = Math.min(spec.length - 1, Math.max(1, Math.round(f / binHz)));
          const db = spec[bin] as number;
          const y = H - Math.min(1, Math.max(0, (db + 100) / 90)) * H;
          g.lineTo(x, y);
        }
        g.lineTo(W, H);
        g.closePath();
        g.fillStyle = 'rgba(118,93,252,0.16)';
        g.fill();
      }
      if (!unit) return;
      // the curve moves with the sidechain (a ducked band dips while its source plays)
      const mods = liveOffsets(trackId, slot.id);
      // selected band's own contribution
      if (sel >= 0 && s.params.bands[sel]?.enabled) {
        unit.response(FREQS, bandMag, sel, mods);
        g.beginPath();
        g.moveTo(0, dbToY(0));
        for (let i = 0; i < N_POINTS; i++) g.lineTo((i / (N_POINTS - 1)) * W, dbToY(clampDb(20 * Math.log10(Math.max(1e-6, bandMag[i] as number)))));
        g.lineTo(W, dbToY(0));
        g.closePath();
        const c = PEQ_BAND_COLORS[sel] ?? '#fff';
        g.fillStyle = `${c}33`;
        g.fill();
      }
      // total response
      unit.response(FREQS, mag, undefined, mods);
      g.beginPath();
      for (let i = 0; i < N_POINTS; i++) {
        const y = dbToY(clampDb(20 * Math.log10(Math.max(1e-6, mag[i] as number))));
        const x = (i / (N_POINTS - 1)) * W;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = s.enabled ? '#f5f5ff' : '#6a6a80';
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
      // nodes
      g.textBaseline = 'middle';
      g.textAlign = 'center';
      g.font = '700 9px Inter, system-ui, sans-serif';
      s.params.bands.forEach((_, i) => {
        const b = effectiveBand(trackId, s, i);
        if (!b.enabled) return;
        const off = mods.get(i);
        const x = fToX(b.freq * Math.pow(2, (off?.cents ?? 0) / 1200));
        const y = dbToY(peqHasGain(b.type) ? clampDb(b.gain + (off?.gain ?? 0)) : 0);
        const c = PEQ_BAND_COLORS[i] ?? '#fff';
        g.beginPath();
        g.arc(x, y, i === sel ? NODE_R + 1.5 : NODE_R, 0, Math.PI * 2);
        g.fillStyle = i === sel ? c : `${c}cc`;
        g.fill();
        if (i === sel || i === hover.current) {
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5;
          g.stroke();
          g.lineWidth = 1;
        }
        g.fillStyle = '#0b0b12';
        g.fillText(String(i + 1), x, y + 0.5);
      });
      g.textAlign = 'left';
      // readout of the selected band
      const sb = sel >= 0 ? effectiveBand(trackId, s, sel) : null;
      if (sb?.enabled) {
        const txt = `${sel + 1} · ${PEQ_TYPE_LABELS[sb.type]} · ${PEQ_SPECS.freq.format(sb.freq)}${peqHasGain(sb.type) ? ` · ${PEQ_SPECS.gain.format(sb.gain)}` : ''}${peqHasQ(sb.type, sb.slope) ? ` · Q ${sb.q.toFixed(2)}` : ''}${sb.type === 'lowcut' || sb.type === 'highcut' ? ` · ${sb.slope} dB/oct` : ''}`;
        g.font = '10px Inter, system-ui, sans-serif';
        g.textBaseline = 'top';
        g.fillStyle = 'rgba(8,8,13,0.8)';
        g.fillRect(W - g.measureText(txt).width - 14, 4, g.measureText(txt).width + 10, 16);
        g.fillStyle = PEQ_BAND_COLORS[sel] ?? '#fff';
        g.fillText(txt, W - g.measureText(txt).width - 9, 7);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [trackId, slot.id]);

  // ---- interaction ----
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = (canvas.current as HTMLCanvasElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const bandMenu = (i: number, at: { x: number; y: number }) => {
    const s = liveSlot(trackId, slot.id);
    const b = s?.params.bands[i];
    if (!s || !b) return;
    const target = (field: string) => ({ kind: 'fx' as const, slotId: slot.id, param: `b${i}.${field}` });
    const items: MenuItem[] = [
      ...PEQ_TYPES.map((t) => ({ label: `${b.type === t ? '✓ ' : '   '}${PEQ_TYPE_LABELS[t]}`, onClick: () => setBand(i, { type: t, q: t === 'lowcut' || t === 'highcut' ? 0.707 : b.q }, `type${i}`) })),
      ...(b.type === 'lowcut' || b.type === 'highcut'
        ? PEQ_SLOPES.map((sl) => ({ label: `${b.slope === sl ? '✓ ' : '   '}${sl} dB/oct`, onClick: () => setBand(i, { slope: sl }, `slope${i}`) }))
        : []),
      ...(peqHasGain(b.type) ? [{ label: 'Reset gain', onClick: () => setBand(i, { gain: 0 }, `reset${i}`) }] : []),
      { label: 'Automate frequency', onClick: () => automate(trackId, target('freq')) },
      ...(peqHasGain(b.type) ? [{ label: 'Automate gain', onClick: () => automate(trackId, target('gain')) }] : []),
      ...(peqHasQ(b.type, b.slope) ? [{ label: 'Automate Q', onClick: () => automate(trackId, target('q')) }] : []),
      { label: 'Remove band', danger: true, onClick: () => setBand(i, { enabled: false }, `remove${i}`) },
    ];
    setMenu({ ...at, items });
  };

  const s = slot;
  const sel = selected >= 0 ? s.params.bands[selected] : undefined;
  const selTarget = (field: string) => ({ kind: 'fx' as const, slotId: slot.id, param: `b${selected}.${field}` });
  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvas}
        style={{ width: W, height: H }}
        className="cursor-crosshair rounded border border-line"
        title="Double-click: add band · drag a node: frequency/gain · wheel: Q · right-click a node: type, slope, automate, remove"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = pos(e);
          const i = hitNode(p.x, p.y);
          if (i < 0) return;
          select(i);
          const ls = liveSlot(trackId, slot.id);
          if (!ls) return;
          const b = effectiveBand(trackId, ls, i);
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { band: i, x: p.x, y: p.y, f: b.freq, g: b.gain, key: `drag${i}-${Date.now()}` };
        }}
        onPointerMove={(e) => {
          const p = pos(e);
          const d = drag.current;
          if (!d) {
            const h = hitNode(p.x, p.y);
            if (h !== hover.current) hover.current = h;
            (e.target as HTMLElement).style.cursor = h >= 0 ? 'grab' : 'crosshair';
            return;
          }
          const fine = e.shiftKey ? 0.2 : 1;
          const ls = liveSlot(trackId, slot.id);
          const b = ls?.params.bands[d.band];
          if (!b) return;
          const freq = clampF(xToF(fToX(d.f) + (p.x - d.x) * fine));
          const part: Partial<PeqBand> = { freq: Math.round(freq * 10) / 10 };
          if (peqHasGain(b.type)) part.gain = Math.round(clampDb(d.g + (yToDb(p.y) - yToDb(d.y)) * fine) * 10) / 10;
          setBand(d.band, part, d.key);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d) {
            endAutomationGesture(`${d.key}-freq`);
            endAutomationGesture(`${d.key}-gain`);
          }
        }}
        onDoubleClick={(e) => {
          const p = pos(e);
          const i = hitNode(p.x, p.y);
          if (i >= 0) {
            const b = s.params.bands[i];
            if (b && peqHasGain(b.type)) setBand(i, { gain: 0 }, `reset${i}`);
          } else addBandAt(p.x, p.y);
        }}
        onWheel={(e) => {
          const p = pos(e);
          const i = hitNode(p.x, p.y) >= 0 ? hitNode(p.x, p.y) : selected;
          const ls = liveSlot(trackId, slot.id);
          const b = i >= 0 ? ls?.params.bands[i] : undefined;
          if (!b || !b.enabled || !peqHasQ(b.type, b.slope) || !ls) return;
          e.stopPropagation();
          const cur = effectiveBand(trackId, ls, i).q;
          const q = Math.min(PEQ_SPECS.q.max, Math.max(PEQ_SPECS.q.min, cur * Math.exp(-e.deltaY * 0.0015)));
          setBand(i, { q: Math.round(q * 100) / 100 }, `wheel${i}`);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = pos(e);
          const i = hitNode(p.x, p.y);
          if (i >= 0) {
            select(i);
            bandMenu(i, { x: e.clientX, y: e.clientY });
          }
        }}
      />
      <div className="flex items-end gap-2">
        <div className="flex gap-1">
          {s.params.bands.map((b, i) => (
            <button
              key={i}
              type="button"
              title={b.enabled ? `Band ${i + 1}: ${PEQ_TYPE_LABELS[b.type]} — click to select` : `Band ${i + 1} (off) — click to enable`}
              onClick={() => {
                if (!b.enabled) setBand(i, { enabled: true }, `en${i}`);
                select(i);
              }}
              className={`h-6 w-6 rounded text-[10px] font-bold ${i === selected ? 'ring-1 ring-white' : ''}`}
              style={{ background: b.enabled ? PEQ_BAND_COLORS[i] : '#1d1d2c', color: b.enabled ? '#0b0b12' : '#5c5c74' }}
            >
              {i + 1}
            </button>
          ))}
        </div>
        {sel ? (
          <div className="flex items-end gap-2 border-l border-line pl-2">
            <div className="flex flex-col gap-1">
              <div className="flex gap-1">
                <button
                  type="button"
                  title={sel.enabled ? 'Turn band off' : 'Turn band on'}
                  onClick={() => setBand(selected, { enabled: !sel.enabled }, `en${selected}`)}
                  className={`flex h-5 w-5 items-center justify-center rounded ${sel.enabled ? 'text-black' : 'bg-panel-3 text-dim'}`}
                  style={sel.enabled ? { background: PEQ_BAND_COLORS[selected] } : undefined}
                >
                  <Power size={10} />
                </button>
                <select value={sel.type} onChange={(e) => setBand(selected, { type: e.target.value as PeqBandType }, `type${selected}`)} className="h-5 text-[10px]" title="Band type">
                  {PEQ_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PEQ_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <select
                value={sel.slope}
                disabled={!(sel.type === 'lowcut' || sel.type === 'highcut')}
                onChange={(e) => setBand(selected, { slope: Number(e.target.value) as PeqSlope }, `slope${selected}`)}
                className="h-5 text-[10px] disabled:opacity-30"
                title="Cut slope"
              >
                {PEQ_SLOPES.map((sl) => (
                  <option key={sl} value={sl}>
                    {sl} dB/oct
                  </option>
                ))}
              </select>
            </div>
            <AutoKnob trackId={trackId} target={selTarget('freq')} spec={PEQ_SPECS.freq} value={sel.freq} color={PEQ_BAND_COLORS[selected]} disabled={!sel.enabled} onChange={(v) => setBand(selected, { freq: v }, `kf${selected}`)} />
            <AutoKnob trackId={trackId} target={selTarget('gain')} spec={PEQ_SPECS.gain} value={sel.gain} color={PEQ_BAND_COLORS[selected]} disabled={!sel.enabled || !peqHasGain(sel.type)} onChange={(v) => setBand(selected, { gain: v }, `kg${selected}`)} />
            <AutoKnob trackId={trackId} target={selTarget('q')} spec={PEQ_SPECS.q} value={sel.q} color={PEQ_BAND_COLORS[selected]} disabled={!sel.enabled || !peqHasQ(sel.type, sel.slope)} onChange={(v) => setBand(selected, { q: v }, `kq${selected}`)} />
          </div>
        ) : (
          <div className="border-l border-line pl-2 text-[10px] text-dim">Double-click the graph to add a band, or click a band number.</div>
        )}
        <div className="ml-auto">
          <AutoKnob
            trackId={trackId}
            target={{ kind: 'fx', slotId: slot.id, param: 'output' }}
            spec={PEQ_SPECS.output}
            value={s.params.output}
            color={color}
            onChange={(v) => setEffectParams(trackId, slot.id, { output: v }, `peq-${slot.id}-out`)}
          />
        </div>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
