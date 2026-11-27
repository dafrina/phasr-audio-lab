import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Power, Save, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import {
  AUTOFILTER_MODES,
  AUTOFILTER_SPECS,
  CHORUS_SPECS,
  LFO_DIVISIONS,
  LFO_SHAPES,
  PHASER_SPECS,
  PHASER_STAGE_CHOICES,
  COMP_SPECS,
  DELAY_DIVISIONS,
  DELAY_SPECS,
  EFFECT_LABELS,
  EQ_SPECS,
  FACTORY_EFFECT_PRESETS,
  REVERB_SPECS,
  ROOM_SPECS,
  SATURATOR_MODES,
  SATURATOR_SPECS,
  EFFECT_BLURBS,
  delayTimeSeconds,
  loadUserEffectPresets,
  saveUserEffectPresets,
  type EffectPreset,
} from '../../audio/effects/specs';
import type { AutoFilterMode, AutoFilterParams, EffectSlot, EqParams, LfoShape, PhaserParams, SaturatorParams } from '../../project/types';
import { moveEffect, removeEffect, replaceEffectParams, setEffectEnabled, setEffectParams } from '../../state/effectActions';
import { useProjectStore } from '../../state/projectStore';
import { uiToast } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { AutoKnob } from '../common/AutoKnob';
import { PeqDevice } from './PeqDevice';
import { ReverbRoomView } from './ReverbRoomView';
import { saturate, saturatorGain, saturatorHarmonics } from '../../audio/saturator/shapes';

const TYPE_COLOR: Record<EffectSlot['type'], string> = {
  eq: '#22d3ee',
  peq: '#f472b6',
  chorus: '#60a5fa',
  autofilter: '#e879f9',
  phaser: '#34d399',
  compressor: '#facc15',
  saturator: '#fb7185',
  delay: '#4ade80',
  reverb: '#9b8aff',
  room: '#a78bfa',
};

/** device widths: the Spectra EQ and Reverb Pro carry big displays */
const DEVICE_W: Partial<Record<EffectSlot['type'], string>> = { peq: 'w-[618px]', reverb: 'w-[484px]' };

function samePar(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function EffectDevice({ trackId, slot, index, count }: { trackId: string; slot: EffectSlot; index: number; count: number }) {
  const [userPresets, setUserPresets] = useState<EffectPreset[]>(() => loadUserEffectPresets());
  const presets = useMemo(
    () => [...FACTORY_EFFECT_PRESETS, ...userPresets].filter((p) => p.type === slot.type),
    [userPresets, slot.type],
  );
  const current = presets.find((p) => samePar(p.params, slot.params));
  const color = TYPE_COLOR[slot.type];
  const key = (k: string) => `fx-${slot.id}-${k}`;
  const set = (params: Partial<EffectSlot['params']>, k: string) => setEffectParams(trackId, slot.id, params, key(k));

  const savePreset = () => {
    const name = prompt(`Save ${EFFECT_LABELS[slot.type]} preset as:`)?.trim();
    if (!name) return;
    if (FACTORY_EFFECT_PRESETS.some((p) => p.type === slot.type && p.name === name)) {
      uiToast('error', `"${name}" is a factory preset name.`);
      return;
    }
    const all = [...loadUserEffectPresets().filter((p) => !(p.type === slot.type && p.name === name)), { name, type: slot.type, factory: false, params: structuredClone(slot.params) }];
    if (!saveUserEffectPresets(all)) return uiToast('error', 'Could not save the preset: browser storage is unavailable.');
    setUserPresets(all);
  };

  return (
    <div className={`flex ${DEVICE_W[slot.type] ?? 'w-[244px]'} shrink-0 flex-col rounded-md border bg-panel-2 ${slot.enabled ? 'border-line-2' : 'border-line opacity-60'}`}>
      <div className="flex h-7 items-center gap-1 border-b border-line px-1.5" style={{ boxShadow: `inset 0 2px 0 ${color}` }}>
        <button
          type="button"
          title={slot.enabled ? 'Bypass effect' : 'Enable effect'}
          onClick={() => setEffectEnabled(trackId, slot.id, !slot.enabled)}
          className={`flex h-4 w-4 items-center justify-center rounded ${slot.enabled ? 'text-black' : 'bg-panel-3 text-dim'}`}
          style={slot.enabled ? { background: color } : undefined}
        >
          <Power size={10} />
        </button>
        <span className="text-[11px] font-semibold tracking-wide text-fg" title={EFFECT_BLURBS[slot.type]}>
          {EFFECT_LABELS[slot.type]}
        </span>
        <select
          value={current?.name ?? ''}
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) replaceEffectParams(trackId, slot.id, p.params, `${EFFECT_LABELS[slot.type]} preset`);
          }}
          className="ml-1 h-5 min-w-0 flex-1 text-[10px]"
          title="Effect preset"
        >
          {!current && <option value="">Custom</option>}
          {presets.map((p) => (
            <option key={`${p.factory}-${p.name}`} value={p.name}>
              {p.name}
              {p.factory ? '' : ' (user)'}
            </option>
          ))}
        </select>
        <button type="button" title="Save as user preset" onClick={savePreset} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
          <Save size={11} />
        </button>
        <button type="button" title="Move earlier in the chain" disabled={index === 0} onClick={() => moveEffect(trackId, slot.id, -1)} className="flex h-5 w-4 items-center justify-center rounded text-muted hover:text-fg disabled:opacity-25">
          <ChevronLeft size={12} />
        </button>
        <button type="button" title="Move later in the chain" disabled={index === count - 1} onClick={() => moveEffect(trackId, slot.id, 1)} className="flex h-5 w-4 items-center justify-center rounded text-muted hover:text-fg disabled:opacity-25">
          <ChevronRight size={12} />
        </button>
        <button type="button" title="Remove effect" onClick={() => removeEffect(trackId, slot.id)} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-bad">
          <X size={12} />
        </button>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-2 p-2">
        {slot.type === 'peq' && <PeqDevice trackId={trackId} slot={slot} color={color} />}
        {slot.type === 'eq' && (
          <>
            <EqCurve params={slot.params} color={color} />
            <div className="flex justify-between">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'lowGain' }} spec={EQ_SPECS.lowGain} value={slot.params.lowGain} color={color} onChange={(v) => set({ lowGain: v }, 'low')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'midGain' }} spec={EQ_SPECS.midGain} value={slot.params.midGain} color={color} onChange={(v) => set({ midGain: v }, 'mid')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'midFreq' }} spec={EQ_SPECS.midFreq} value={slot.params.midFreq} color={color} onChange={(v) => set({ midFreq: v }, 'freq')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'highGain' }} spec={EQ_SPECS.highGain} value={slot.params.highGain} color={color} onChange={(v) => set({ highGain: v }, 'high')} />
            </div>
          </>
        )}
        {slot.type === 'compressor' && (
          <>
            <GainReduction trackId={trackId} slotId={slot.id} />
            <div className="flex justify-between">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'threshold' }} spec={COMP_SPECS.threshold} value={slot.params.threshold} color={color} onChange={(v) => set({ threshold: v }, 'thr')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'ratio' }} spec={COMP_SPECS.ratio} value={slot.params.ratio} color={color} onChange={(v) => set({ ratio: v }, 'ratio')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'attack' }} spec={COMP_SPECS.attack} value={slot.params.attack} color={color} onChange={(v) => set({ attack: v }, 'atk')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'release' }} spec={COMP_SPECS.release} value={slot.params.release} color={color} onChange={(v) => set({ release: v }, 'rel')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'makeup' }} spec={COMP_SPECS.makeup} value={slot.params.makeup} color={color} onChange={(v) => set({ makeup: v }, 'mk')} />
            </div>
          </>
        )}
        {slot.type === 'saturator' && <SaturatorBody trackId={trackId} slot={slot} color={color} set={set} />}
        {slot.type === 'delay' && <DelayBody trackId={trackId} slot={slot} color={color} set={set} />}
        {slot.type === 'autofilter' && <AutoFilterBody trackId={trackId} slot={slot} color={color} set={set} />}
        {slot.type === 'phaser' && <PhaserBody trackId={trackId} slot={slot} color={color} set={set} />}
        {slot.type === 'chorus' && (
          <>
            <div className="flex justify-between">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'rate' }} spec={CHORUS_SPECS.rate} value={slot.params.rate} color={color} onChange={(v) => set({ rate: v }, 'rate')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'depth' }} spec={CHORUS_SPECS.depth} value={slot.params.depth} color={color} onChange={(v) => set({ depth: v }, 'depth')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'delay' }} spec={CHORUS_SPECS.delay} value={slot.params.delay} color={color} onChange={(v) => set({ delay: v }, 'delay')} />
            </div>
            <div className="flex justify-between">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'feedback' }} spec={CHORUS_SPECS.feedback} value={slot.params.feedback} color={color} onChange={(v) => set({ feedback: v }, 'fb')} />
              <Knob spec={CHORUS_SPECS.width} value={slot.params.width} color={color} onChange={(v) => set({ width: v }, 'width')} title="Stereo width: phase offset between the left and right sweeps" />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'mix' }} spec={CHORUS_SPECS.mix} value={slot.params.mix} color={color} onChange={(v) => set({ mix: v }, 'mix')} />
            </div>
            <div className="text-center text-[9px] text-dim">
              {slot.params.delay < 0.006 && Math.abs(slot.params.feedback) > 0.3 ? 'Flanger' : slot.params.mix > 0.95 ? 'Vibrato' : 'Chorus'} — presets: Chorus, Wide Chorus, Flanger, Jet Flanger, Vibrato
            </div>
          </>
        )}
        {slot.type === 'reverb' && (
          <>
            <ReverbRoomView decay={slot.params.decay} preDelay={slot.params.preDelay} mix={slot.params.mix} color={color} />
            <div className="flex items-center justify-around">
              <Knob spec={REVERB_SPECS.decay} value={slot.params.decay} color={color} size={40} onChange={(v) => set({ decay: v }, 'decay')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'preDelay' }} spec={REVERB_SPECS.preDelay} value={slot.params.preDelay} color={color} size={40} onChange={(v) => set({ preDelay: v }, 'pre')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'mix' }} spec={REVERB_SPECS.mix} value={slot.params.mix} color={color} size={40} onChange={(v) => set({ mix: v }, 'mix')} />
              <div className="w-[150px] text-[9px] leading-tight text-dim">
                <span className="font-semibold" style={{ color }}>
                  PRO · convolution
                </span>
                <br />
                Real room impulse, every echo rendered. CPU grows with the decay: ≈ {(0.5 + 1.5 * slot.params.decay).toFixed(1)} % of a core. For lots of tracks, try Reverb Lite or a send.
              </div>
            </div>
          </>
        )}
        {slot.type === 'room' && (
          <>
            <div className="flex justify-between">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'decay' }} spec={ROOM_SPECS.decay} value={slot.params.decay} color={color} onChange={(v) => set({ decay: v }, 'decay')} />
              <Knob spec={ROOM_SPECS.size} value={slot.params.size} color={color} onChange={(v) => set({ size: v }, 'size')} title="Size: how big the room is (booth → cathedral)" />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'tone' }} spec={ROOM_SPECS.tone} value={slot.params.tone} color={color} onChange={(v) => set({ tone: v }, 'tone')} />
            </div>
            <div className="flex justify-around">
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'preDelay' }} spec={ROOM_SPECS.preDelay} value={slot.params.preDelay} color={color} onChange={(v) => set({ preDelay: v }, 'pre')} />
              <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'mix' }} spec={ROOM_SPECS.mix} value={slot.params.mix} color={color} onChange={(v) => set({ mix: v }, 'mix')} />
            </div>
            <div className="text-center text-[9px] text-dim">
              LITE · algorithmic room — ≈ 0.8 % of a core at any decay, sleeps when silent; decay can be automated and sidechained
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SaturatorBody({ trackId, slot, color, set }: { trackId: string; slot: Extract<EffectSlot, { type: 'saturator' }>; color: string; set: (p: Partial<EffectSlot['params']>, k: string) => void }) {
  const p = slot.params;
  const knob = (key: 'drive' | 'tone' | 'output' | 'mix', k: string) => (
    <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: key }} spec={SATURATOR_SPECS[key]} value={p[key]} color={color} onChange={(v) => set({ [key]: v } as Partial<SaturatorParams>, k)} />
  );
  return (
    <>
      <div className="flex gap-[2px]">
        {SATURATOR_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            title={m.title}
            onClick={() => set({ mode: m.value }, 'mode')}
            className={`h-5 flex-1 rounded text-[10px] font-semibold ${p.mode === m.value ? 'text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
            style={p.mode === m.value ? { background: color } : undefined}
          >
            {m.label}
          </button>
        ))}
      </div>
      <SaturatorDisplay params={p} color={color} />
      <div className="flex justify-between">
        {knob('drive', 'drive')}
        {knob('tone', 'tone')}
        {knob('output', 'out')}
        {knob('mix', 'mix')}
      </div>
      <button
        type="button"
        title="Auto gain: the level stays the same while you turn the drive, so you hear the character, not just louder"
        onClick={() => set({ autoGain: !p.autoGain }, 'ag')}
        className={`mx-auto h-5 rounded px-2 text-[10px] font-semibold uppercase tracking-wide ${p.autoGain ? 'text-black' : 'bg-panel-3 text-muted'}`}
        style={p.autoGain ? { background: color } : undefined}
      >
        Auto gain
      </button>
    </>
  );
}

/** Transfer curve (input → output at this drive) and the harmonics it adds to a sine. */
function SaturatorDisplay({ params, color }: { params: SaturatorParams; color: string }) {
  const W = 228;
  const H = 64;
  const CW = 64;
  const { path, bars } = useMemo(() => {
    const g = Math.pow(10, params.drive / 20);
    const comp = params.autoGain ? 1 / saturatorGain(params.mode, params.drive) : 1;
    let d = '';
    for (let i = 0; i <= 64; i++) {
      const x = (i / 64) * 2 - 1;
      const y = Math.max(-1.1, Math.min(1.1, saturate(params.mode, x * g) * Math.min(comp, 4)));
      d += `${i ? 'L' : 'M'}${(2 + ((x + 1) / 2) * (CW - 4)).toFixed(1)},${(H / 2 - y * (H / 2 - 4)).toFixed(1)}`;
    }
    const h = saturatorHarmonics(params.mode, params.drive, 10);
    return { path: d, bars: h };
  }, [params.mode, params.drive, params.autoGain]);
  const bx = CW + 10;
  const bw = (W - bx - 4) / bars.length;
  return (
    <svg width={W} height={H} className="rounded bg-base" aria-label="Saturation curve and harmonics">
      <line x1={2} y1={H / 2} x2={CW - 2} y2={H / 2} stroke="#2a2a3d" />
      <line x1={CW / 2} y1={4} x2={CW / 2} y2={H - 4} stroke="#2a2a3d" />
      <line x1={2} y1={H - 4} x2={CW - 2} y2={4} stroke="#3a3a52" strokeDasharray="2 2" />
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
      {bars.map((db, k) => {
        // 0 dB (fundamental) … −80 dB
        const v = Math.max(0, Math.min(1, (db + 80) / 80));
        const even = (k + 1) % 2 === 0;
        return (
          <g key={k}>
            <rect x={bx + k * bw + 1} y={H - 12 - v * (H - 26)} width={bw - 2} height={Math.max(1, v * (H - 26))} rx={1} fill={k === 0 ? '#e8e8f2' : even ? '#fbbf24' : color} opacity={k === 0 ? 0.55 : 0.9} />
            <text x={bx + k * bw + bw / 2} y={H - 2} textAnchor="middle" fontSize={7} fill="#6a6a86">
              {k + 1}
            </text>
          </g>
        );
      })}
      <text x={W - 4} y={9} textAnchor="end" fontSize={7} fill="#8b8ba6">
        harmonics · <tspan fill={color}>odd</tspan> <tspan fill="#fbbf24">even</tspan>
      </text>
    </svg>
  );
}

function DelayBody({ trackId, slot, color, set }: { trackId: string; slot: Extract<EffectSlot, { type: 'delay' }>; color: string; set: (p: Partial<EffectSlot['params']>, k: string) => void }) {
  const bpm = useProjectStore((s) => s.project.bpm);
  const p = slot.params;
  const eff = delayTimeSeconds(p, bpm);
  return (
    <>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <button
          type="button"
          title="Sync delay time to the project tempo"
          onClick={() => set({ sync: !p.sync }, 'sync')}
          className={`h-5 rounded px-1.5 font-semibold uppercase tracking-wide ${p.sync ? 'text-black' : 'bg-panel-3 text-muted'}`}
          style={p.sync ? { background: color } : undefined}
        >
          Sync
        </button>
        {p.sync ? (
          <select value={p.division} onChange={(e) => set({ division: Number(e.target.value) }, 'div')} title="Delay note division" className="flex-1">
            {DELAY_DIVISIONS.map((d) => (
              <option key={d.label} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1" />
        )}
        <span className="font-mono text-muted" title="Effective delay time">
          {Math.round(eff * 1000)} ms
        </span>
      </div>
      <div className="flex justify-around">
        <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'time' }} spec={DELAY_SPECS.time} value={p.time} color={color} disabled={p.sync} onChange={(v) => set({ time: v }, 'time')} />
        <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'feedback' }} spec={DELAY_SPECS.feedback} value={p.feedback} color={color} onChange={(v) => set({ feedback: v }, 'fb')} />
        <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: 'mix' }} spec={DELAY_SPECS.mix} value={p.mix} color={color} onChange={(v) => set({ mix: v }, 'mix')} />
      </div>
    </>
  );
}

function AutoFilterBody({ trackId, slot, color, set }: { trackId: string; slot: Extract<EffectSlot, { type: 'autofilter' }>; color: string; set: (p: Partial<EffectSlot['params']>, k: string) => void }) {
  const p = slot.params;
  const knob = (key: 'cutoff' | 'reso' | 'lfoDepth' | 'mix', k: string) => (
    <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: key }} spec={AUTOFILTER_SPECS[key]} value={p[key]} color={color} onChange={(v) => set({ [key]: v } as Partial<AutoFilterParams>, k)} />
  );
  return (
    <>
      <FilterCurve params={p} color={color} />
      <div className="flex items-center gap-1 text-[10px]">
        <select value={p.mode} onChange={(e) => set({ mode: e.target.value as AutoFilterMode }, 'mode')} title="Filter type (24 dB/oct)" className="flex-1">
          {AUTOFILTER_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={p.shape} onChange={(e) => set({ shape: e.target.value as LfoShape }, 'shape')} title="LFO shape" className="w-[64px]">
          {LFO_SHAPES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-between">
        {knob('cutoff', 'cut')}
        {knob('reso', 'res')}
        {knob('lfoDepth', 'lfo')}
        {knob('mix', 'mix')}
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <button
          type="button"
          title="Sync the LFO to the project tempo"
          onClick={() => set({ sync: !p.sync }, 'sync')}
          className={`h-5 rounded px-1.5 font-semibold uppercase tracking-wide ${p.sync ? 'text-black' : 'bg-panel-3 text-muted'}`}
          style={p.sync ? { background: color } : undefined}
        >
          Sync
        </button>
        {p.sync ? (
          <select value={p.division} onChange={(e) => set({ division: Number(e.target.value) }, 'div')} title="One LFO cycle lasts…" className="flex-1">
            {LFO_DIVISIONS.map((d) => (
              <option key={d.label} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex flex-1 justify-center">
            <Knob spec={AUTOFILTER_SPECS.rate} value={p.rate} size={22} color={color} onChange={(v) => set({ rate: v }, 'rate')} />
          </div>
        )}
      </div>
    </>
  );
}

function PhaserBody({ trackId, slot, color, set }: { trackId: string; slot: Extract<EffectSlot, { type: 'phaser' }>; color: string; set: (p: Partial<EffectSlot['params']>, k: string) => void }) {
  const p = slot.params;
  const knob = (key: 'center' | 'depth' | 'feedback' | 'mix', k: string) => (
    <AutoKnob trackId={trackId} target={{ kind: 'fx', slotId: slot.id, param: key }} spec={PHASER_SPECS[key]} value={p[key]} color={color} onChange={(v) => set({ [key]: v } as Partial<PhaserParams>, k)} />
  );
  return (
    <>
      <PhaserCurve params={p} color={color} />
      <div className="flex items-center gap-1 text-[10px]" title="All-pass stages: every two make one notch (more = a denser, more intense sweep)">
        <span className="text-muted">Stages</span>
        <div className="inline-flex overflow-hidden rounded border border-line">
          {PHASER_STAGE_CHOICES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => set({ stages: n }, 'stages')}
              className={`px-1.5 py-0.5 ${p.stages === n ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
              style={p.stages === n ? { background: color } : undefined}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-between">
        {knob('center', 'ctr')}
        {knob('depth', 'dep')}
        {knob('feedback', 'fb')}
        {knob('mix', 'mix')}
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <button
          type="button"
          title="Sync the sweep to the project tempo"
          onClick={() => set({ sync: !p.sync }, 'sync')}
          className={`h-5 rounded px-1.5 font-semibold uppercase tracking-wide ${p.sync ? 'text-black' : 'bg-panel-3 text-muted'}`}
          style={p.sync ? { background: color } : undefined}
        >
          Sync
        </button>
        {p.sync ? (
          <select value={p.division} onChange={(e) => set({ division: Number(e.target.value) }, 'div')} title="One sweep cycle lasts…" className="flex-1">
            {LFO_DIVISIONS.map((d) => (
              <option key={d.label} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="flex flex-1 justify-center">
            <Knob spec={PHASER_SPECS.rate} value={p.rate} size={22} color={color} onChange={(v) => set({ rate: v }, 'rate')} />
          </div>
        )}
        <Knob spec={PHASER_SPECS.stereo} value={p.stereo} size={22} color={color} onChange={(v) => set({ stereo: v }, 'st')} title="Stereo: the right channel sweeps ahead of the left (a swirl across the speakers)" />
      </div>
    </>
  );
}

/** Where the phaser's notches sit at the centre of the sweep (dry + phased at the mix), with the sweep range shaded. */
function PhaserCurve({ params, color }: { params: PhaserParams; color: string }) {
  const W = 224;
  const H = 54;
  const fx = (f: number) => (Math.log10(Math.max(20, f) / 20) / 3) * W;
  const N = 140;
  const wet = Math.sin((params.mix * Math.PI) / 2);
  const dry = Math.cos((params.mix * Math.PI) / 2);
  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    const f = 20 * Math.pow(1000, i / (N - 1));
    // N first-order all-passes: phase −2·atan(f/fc) each
    const ph = -2 * params.stages * Math.atan(f / params.center);
    const re = dry + wet * Math.cos(ph);
    const im = wet * Math.sin(ph);
    const db = 20 * Math.log10(Math.max(1e-4, Math.hypot(re, im) / (dry + wet)));
    const y = 4 + (Math.min(0, Math.max(-30, db)) / -30) * (H - 8);
    pts.push(`${i ? 'L' : 'M'}${((i / (N - 1)) * W).toFixed(1)},${y.toFixed(1)}`);
  }
  const lo = params.center / Math.pow(2, params.depth);
  const hi = params.center * Math.pow(2, params.depth);
  return (
    <svg width={W} height={H} className="rounded bg-base" aria-label="Phaser notches">
      {params.depth > 0.01 && <rect x={fx(lo)} y={0} width={Math.max(1, fx(hi) - fx(lo))} height={H} fill={color} opacity={0.12} />}
      {[100, 1000, 10000].map((f) => (
        <line key={f} x1={fx(f)} x2={fx(f)} y1={0} y2={H} stroke="#1f1f2e" />
      ))}
      <path d={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/** Auto-Filter response at the cutoff, with the LFO's sweep range shaded. */
function FilterCurve({ params, color }: { params: AutoFilterParams; color: string }) {
  const W = 224;
  const H = 54;
  const nodes = useRef<BiquadFilterNode[] | null>(null);
  const [path, setPath] = useState('');
  const fx = (f: number) => (Math.log10(Math.max(20, f) / 20) / 3) * W;
  useEffect(() => {
    const ctx = engine.ctx;
    if (!ctx) return;
    nodes.current ??= [new BiquadFilterNode(ctx), new BiquadFilterNode(ctx)];
    const [a, b] = nodes.current as [BiquadFilterNode, BiquadFilterNode];
    const bp = params.mode === 'bandpass';
    for (const n of [a, b]) {
      n.type = params.mode;
      n.frequency.value = params.cutoff;
    }
    a.Q.value = bp ? 0.7 + params.reso * 2 : 20 * Math.log10(0.5412);
    b.Q.value = bp ? 0.7 + params.reso * 9 : 20 * Math.log10(1.3066) + params.reso * 16;
    const N = 120;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
    const total = new Float32Array(N).fill(0);
    const mag = new Float32Array(N);
    const phase = new Float32Array(N);
    for (const n of [a, b]) {
      n.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < N; i++) total[i] = (total[i] as number) + 20 * Math.log10(Math.max(1e-6, mag[i] as number));
    }
    const pts: string[] = [];
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      // 0 dB a third of the way down; −36 dB at the bottom
      const y = H * 0.33 - ((total[i] as number) / 36) * (H * 0.67);
      pts.push(`${i ? 'L' : 'M'}${x.toFixed(1)},${Math.min(H, Math.max(1, y)).toFixed(1)}`);
    }
    setPath(pts.join(' '));
  }, [params]);
  const lo = params.cutoff / Math.pow(2, params.lfoDepth);
  const hi = params.cutoff * Math.pow(2, params.lfoDepth);
  return (
    <svg width={W} height={H} className="rounded bg-base" aria-label="Filter response">
      {params.lfoDepth > 0.01 && <rect x={fx(lo)} y={0} width={Math.max(1, fx(hi) - fx(lo))} height={H} fill={color} opacity={0.12} />}
      {[100, 1000, 10000].map((f) => (
        <line key={f} x1={fx(f)} x2={fx(f)} y1={0} y2={H} stroke="#1f1f2e" />
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/** EQ magnitude response computed by the browser's own biquad implementation. */
function EqCurve({ params, color }: { params: EqParams; color: string }) {
  const W = 224;
  const H = 54;
  const nodes = useRef<BiquadFilterNode[] | null>(null);
  const [path, setPath] = useState('');
  useEffect(() => {
    const ctx = engine.ctx;
    if (!ctx) return;
    nodes.current ??= [
      new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 220 }),
      new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.8 }),
      new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4500 }),
    ];
    const [lo, mid, hi] = nodes.current as [BiquadFilterNode, BiquadFilterNode, BiquadFilterNode];
    lo.gain.value = params.lowGain;
    mid.gain.value = params.midGain;
    mid.frequency.value = params.midFreq;
    hi.gain.value = params.highGain;
    const N = 120;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
    const total = new Float32Array(N).fill(0);
    const mag = new Float32Array(N);
    const phase = new Float32Array(N);
    for (const n of [lo, mid, hi]) {
      n.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < N; i++) total[i] = (total[i] as number) + 20 * Math.log10(Math.max(1e-6, mag[i] as number));
    }
    const pts: string[] = [];
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const y = H / 2 - ((total[i] as number) / 20) * (H / 2 - 3);
      pts.push(`${i ? 'L' : 'M'}${x.toFixed(1)},${Math.min(H, Math.max(0, y)).toFixed(1)}`);
    }
    setPath(pts.join(' '));
  }, [params]);
  return (
    <svg width={W} height={H} className="rounded bg-base" aria-label="EQ response">
      {[100, 1000, 10000].map((f) => {
        const x = (Math.log10(f / 20) / 3) * W;
        return <line key={f} x1={x} x2={x} y1={0} y2={H} stroke="#1f1f2e" />;
      })}
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#2a2a3d" />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/** Live gain-reduction bar read from the running DynamicsCompressorNode. */
function GainReduction({ trackId, slotId }: { trackId: string; slotId: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = Math.min(0, engine.compressorReduction(trackId, slotId));
      if (bar.current) bar.current.style.width = `${Math.min(100, (-r / 24) * 100)}%`;
      if (label.current) label.current.textContent = `${r.toFixed(1)} dB`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [trackId, slotId]);
  return (
    <div className="flex items-center gap-2" title="Gain reduction">
      <span className="text-[9px] uppercase tracking-wide text-muted">GR</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded bg-base">
        <div ref={bar} className="absolute right-0 top-0 h-full bg-warn" style={{ width: 0 }} />
      </div>
      <span ref={label} className="w-12 text-right font-mono text-[10px] text-muted">
        0.0 dB
      </span>
    </div>
  );
}
