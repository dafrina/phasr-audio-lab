import { useEffect, useRef, useState } from 'react';
import { Activity, Power, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { MOD_SPECS, TRACK_MOD_PARAMS, modParamInfo, modulatableEffectParams, sourceKinds } from '../../project/modulation';
import { EFFECT_LABELS } from '../../audio/effects/specs';
import type { AutomationTarget, InstrumentConfig, ModRoute, ModSourceKind, Track } from '../../project/types';
import { noteLabelFor } from '../../instruments/definitions';
import { midiNoteName } from '../../core/time';
import { addModRoute, removeModRoute, updateModRoute } from '../../state/modulationActions';
import { useProjectStore } from '../../state/projectStore';
import { Knob } from '../common/Knob';

const MOD_COLOR = '#22d3ee';

/** Note choices for a MIDI route: named pads for drum racks, otherwise a range of notes. */
function noteOptions(inst: InstrumentConfig | null): { note: number; label: string }[] {
  const out: { note: number; label: string }[] = [];
  for (let n = 24; n <= 96; n++) {
    const pad = noteLabelFor(inst, n);
    if (pad !== null) out.push({ note: n, label: pad });
  }
  if (out.length) return out;
  for (let n = 24; n <= 96; n++) out.push({ note: n, label: midiNoteName(n) });
  return out;
}

function targetOptions(track: Track): { value: string; label: string; target: AutomationTarget }[] {
  const out = TRACK_MOD_PARAMS.map((p) => ({ value: `track:${p.key}`, label: p.label, target: { kind: 'track', param: p.key } as AutomationTarget }));
  for (const slot of track.effects) {
    for (const p of modulatableEffectParams(track, slot.id)) {
      out.push({ value: `fx:${slot.id}:${p.key}`, label: `${EFFECT_LABELS[slot.type]} · ${p.label}`, target: { kind: 'fx', slotId: slot.id, param: p.key } });
    }
  }
  return out;
}

/** Live envelope bar read from the route's modulator output. */
function EnvMeter({ routeId }: { routeId: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = engine.modulation?.level(routeId) ?? 0;
      if (bar.current) bar.current.style.height = `${Math.round(v * 100)}%`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [routeId]);
  return (
    <div className="relative h-9 w-2 overflow-hidden rounded-sm bg-base" title="Modulation envelope (live)">
      <div ref={bar} className="absolute bottom-0 left-0 right-0" style={{ background: MOD_COLOR, height: 0 }} />
    </div>
  );
}

function RouteRow({ track, route }: { track: Track; route: ModRoute }) {
  const src = useProjectStore((s) => s.project.tracks.find((t) => t.id === route.sourceTrackId));
  const info = modParamInfo(track, route.target);
  if (!info) return null;
  const set = (part: Partial<ModRoute>, k: string) => updateModRoute(track.id, route.id, part, `mod-${route.id}-${k}`);
  return (
    <div className={`flex items-center gap-2 rounded border border-line bg-base/40 px-1.5 py-1 ${route.enabled ? '' : 'opacity-50'}`}>
      <button
        type="button"
        title={route.enabled ? 'Disable route' : 'Enable route'}
        onClick={() => updateModRoute(track.id, route.id, { enabled: !route.enabled })}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${route.enabled ? 'text-black' : 'bg-panel-3 text-dim'}`}
        style={route.enabled ? { background: MOD_COLOR } : undefined}
      >
        <Power size={9} />
      </button>
      <div className="w-[104px] min-w-0 text-[10px] leading-tight">
        <div className="truncate text-fg" title={src?.name}>
          <span className="mr-1 rounded px-1 text-[9px] font-bold text-black" style={{ background: src?.color ?? '#888' }}>
            {route.source === 'midi' ? 'MIDI' : 'AUD'}
          </span>
          {src?.name ?? 'missing'}
        </div>
        <div className="truncate text-muted" title={info.fullLabel}>
          → {info.fullLabel}
        </div>
      </div>
      {route.source === 'midi' && (
        <select
          value={route.note ?? ''}
          onChange={(e) => updateModRoute(track.id, route.id, { note: e.target.value === '' ? null : Number(e.target.value) })}
          className="h-5 w-[78px] !pl-1 !pr-4 text-[10px]"
          title="Only this note triggers the envelope (e.g. the kick pad of a drum rack)"
        >
          <option value="">Any note</option>
          {noteOptions(src?.instrument ?? null).map((o) => (
            <option key={o.note} value={o.note}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <EnvMeter routeId={route.id} />
      <Knob spec={info.depth} value={route.depth} size={28} color={MOD_COLOR} onChange={(v) => set({ depth: v }, 'depth')} />
      <Knob spec={MOD_SPECS.attack} value={route.attack} size={28} color={MOD_COLOR} onChange={(v) => set({ attack: v }, 'atk')} />
      <Knob spec={MOD_SPECS.release} value={route.release} size={28} color={MOD_COLOR} onChange={(v) => set({ release: v }, 'rel')} />
      {route.source === 'audio' ? (
        <Knob spec={MOD_SPECS.threshold} value={route.threshold} size={28} color={MOD_COLOR} onChange={(v) => set({ threshold: v }, 'thr')} title={`Threshold: the envelope opens over ${MOD_SPECS.threshold.format(route.threshold)} … +12 dB`} />
      ) : (
        <Knob spec={MOD_SPECS.hold} value={route.hold} size={28} color={MOD_COLOR} onChange={(v) => set({ hold: v }, 'hold')} />
      )}
      <button
        type="button"
        title="Invert: modulate while the source is quiet"
        onClick={() => updateModRoute(track.id, route.id, { invert: !route.invert })}
        className={`h-5 rounded px-1 text-[9px] font-semibold uppercase ${route.invert ? 'text-black' : 'bg-panel-3 text-muted'}`}
        style={route.invert ? { background: MOD_COLOR } : undefined}
      >
        Inv
      </button>
      <button type="button" title="Remove route" onClick={() => removeModRoute(track.id, route.id)} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-bad">
        <X size={11} />
      </button>
    </div>
  );
}

/** Sidechain / modulation routes that act on this track. */
export function ModulationCard({ track }: { track: Track }) {
  const tracks = useProjectStore((s) => s.project.tracks);
  const opts = targetOptions(track);
  const [srcId, setSrcId] = useState('');
  // null = automatic: MIDI notes for instrument sources (tightest), audio otherwise
  const [kind, setKind] = useState<ModSourceKind | null>(null);
  const [tgt, setTgt] = useState(opts[0]?.value ?? '');
  const src = tracks.find((t) => t.id === srcId);
  const kinds = src ? sourceKinds(src) : (['audio'] as ModSourceKind[]);
  const effKind = kind && kinds.includes(kind) ? kind : (kinds[0] as ModSourceKind);
  const target = opts.find((o) => o.value === tgt)?.target ?? opts[0]?.target;
  return (
    <div className="flex w-[470px] shrink-0 flex-col gap-1.5 rounded-md border border-line-2 bg-panel-2 p-2" style={{ boxShadow: `inset 0 2px 0 ${MOD_COLOR}` }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg">
        <Activity size={12} style={{ color: MOD_COLOR }} /> Sidechain
        <span className="font-normal text-dim">— parameters on this track driven by other tracks</span>
      </div>
      {track.modulations.length === 0 && (
        <div className="text-[10px] text-dim">No routes yet. Right-click any knob → “Sidechain from…”, use the track header’s Auto menu → “Duck from”, or add one below.</div>
      )}
      {track.modulations.map((r) => (
        <RouteRow key={r.id} track={track} route={r} />
      ))}
      <div className="mt-1 flex items-center gap-1 text-[10px]">
        <span className="text-muted">From</span>
        <select value={srcId} onChange={(e) => setSrcId(e.target.value)} className="h-5 max-w-[110px]">
          <option value="">track…</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.id === track.id ? ' (self)' : ''}
            </option>
          ))}
        </select>
        <select value={effKind} onChange={(e) => setKind(e.target.value as ModSourceKind)} className="h-5" disabled={!src}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k === 'midi' ? 'MIDI notes' : 'Audio level'}
            </option>
          ))}
        </select>
        <span className="text-muted">to</span>
        <select value={tgt} onChange={(e) => setTgt(e.target.value)} className="h-5 min-w-0 flex-1">
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!src || !target}
          onClick={() => src && target && addModRoute(track.id, src.id, effKind, target)}
          className="h-5 rounded px-2 text-[10px] font-semibold text-black disabled:opacity-30"
          style={{ background: MOD_COLOR }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
