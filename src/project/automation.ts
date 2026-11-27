/**
 * Parameter automation: pure lane/point operations, interpolation, the
 * registry of automatable parameters, and validation of stored lanes.
 *
 * Values are stored in each parameter's own units (dB, Hz, 0..1 …) so a lane
 * stays meaningful if the UI changes. Between points the value is linearly
 * interpolated (exponential-curve parameters such as frequency are ramped
 * exponentially by the scheduler, which matches how they're heard).
 */
import { createId } from '../core/ids';
import {
  AUTOFILTER_SPECS, CHORUS_SPECS, PHASER_SPECS, ROOM_SPECS, SATURATOR_SPECS, UTILITY_SPECS,
  COMP_SPECS,
  DELAY_SPECS,
  EFFECT_LABELS,
  EQ_SPECS,
  PEQ_BANDS,
  PEQ_SPECS,
  REVERB_SPECS,
  peqHasGain,
  peqHasQ,
} from '../audio/effects/specs';
import type { NumericParamSpec } from '../synth/params';
import { INSTRUMENTS, instrumentAutoParams, instrumentStaticValue } from '../instruments/definitions';
import type { AutomationLane, AutomationPoint, AutomationTarget, EffectSlot, Track } from './types';

export interface AutoParamInfo {
  key: string;
  label: string;
  spec: NumericParamSpec;
}

const VOLUME_SPEC: NumericParamSpec = {
  label: 'Volume',
  min: -60,
  max: 6,
  default: 0,
  curve: 'linear',
  format: (v) => (v <= -59.9 ? '-∞ dB' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`),
};
const PAN_SPEC: NumericParamSpec = {
  label: 'Pan',
  min: -1,
  max: 1,
  default: 0,
  curve: 'linear',
  bipolar: true,
  format: (v) => (Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`),
};

export const TRACK_AUTO_PARAMS: AutoParamInfo[] = [
  { key: 'volumeDb', label: 'Volume', spec: VOLUME_SPEC },
  { key: 'pan', label: 'Pan', spec: PAN_SPEC },
];

/**
 * Parameters of an effect that can be automated (all are backed by AudioParams).
 * With `any`, every parameter the effect type can have, whatever its settings now:
 * a lane on a Spectra EQ band that's switched off, or on Delay Time while Sync is
 * on, is only paused — it must survive save / load (switching back revives it).
 */
export function automatableParams(slot: EffectSlot, any = false): AutoParamInfo[] {
  switch (slot.type) {
    case 'eq':
      return (['lowGain', 'midGain', 'midFreq', 'highGain'] as const).map((k) => ({ key: k, label: EQ_SPECS[k].label, spec: EQ_SPECS[k] }));
    case 'peq': {
      const out: AutoParamInfo[] = [];
      slot.params.bands.forEach((b, i) => {
        if (!b.enabled && !any) return;
        out.push({ key: `b${i}.freq`, label: `Band ${i + 1} Freq`, spec: PEQ_SPECS.freq });
        if (any || peqHasGain(b.type)) out.push({ key: `b${i}.gain`, label: `Band ${i + 1} Gain`, spec: PEQ_SPECS.gain });
        if (any || peqHasQ(b.type, b.slope)) out.push({ key: `b${i}.q`, label: `Band ${i + 1} Q`, spec: PEQ_SPECS.q });
      });
      out.push({ key: 'output', label: 'Output', spec: PEQ_SPECS.output });
      return out;
    }
    case 'compressor':
      return (['threshold', 'ratio', 'attack', 'release', 'makeup'] as const).map((k) => ({ key: k, label: COMP_SPECS[k].label, spec: COMP_SPECS[k] }));
    case 'delay': {
      const keys = slot.params.sync && !any ? (['feedback', 'mix'] as const) : (['time', 'feedback', 'mix'] as const);
      return keys.map((k) => ({ key: k, label: DELAY_SPECS[k].label, spec: DELAY_SPECS[k] }));
    }
    case 'reverb':
      return (['preDelay', 'lowCut', 'highCut', 'width', 'mix'] as const).map((k) => ({ key: k, label: REVERB_SPECS[k].label, spec: REVERB_SPECS[k] }));
    case 'chorus':
      return (['rate', 'depth', 'delay', 'feedback', 'mix'] as const).map((k) => ({ key: k, label: CHORUS_SPECS[k].label, spec: CHORUS_SPECS[k] }));
    case 'autofilter':
      return (['cutoff', 'reso', 'lfoDepth', 'mix'] as const).map((k) => ({ key: k, label: AUTOFILTER_SPECS[k].label, spec: AUTOFILTER_SPECS[k] }));
    case 'phaser':
      return (['center', 'depth', 'feedback', 'mix'] as const).map((k) => ({ key: k, label: PHASER_SPECS[k].label, spec: PHASER_SPECS[k] }));
    case 'room':
      return (['decay', 'tone', 'preDelay', 'mix'] as const).map((k) => ({ key: k, label: ROOM_SPECS[k].label, spec: ROOM_SPECS[k] }));
    case 'saturator':
      return (['drive', 'bits', 'rate', 'tone', 'output', 'mix'] as const).map((k) => ({ key: k, label: SATURATOR_SPECS[k].label, spec: SATURATOR_SPECS[k] }));
    case 'utility':
      return (['gain', 'pan', 'width'] as const).map((k) => ({ key: k, label: UTILITY_SPECS[k].label, spec: UTILITY_SPECS[k] }));
  }
}

/** Parse a Spectra EQ band key like "b3.gain". */
export function parseBandKey(key: string): { band: number; field: 'freq' | 'gain' | 'q' } | null {
  const m = /^b(\d)\.(freq|gain|q)$/.exec(key);
  if (!m) return null;
  const band = Number(m[1]);
  if (band < 0 || band >= PEQ_BANDS) return null;
  return { band, field: m[2] as 'freq' | 'gain' | 'q' };
}

export function sameTarget(a: AutomationTarget, b: AutomationTarget): boolean {
  if (a.kind === 'track' && b.kind === 'track') return a.param === b.param;
  if (a.kind === 'fx' && b.kind === 'fx') return a.slotId === b.slotId && a.param === b.param;
  if (a.kind === 'inst' && b.kind === 'inst') return a.param === b.param;
  return false;
}

/** Info (label + spec) for a lane target on a track, or null if the target no longer exists. */
export function targetInfo(track: Track, t: AutomationTarget): (AutoParamInfo & { fullLabel: string }) | null {
  if (t.kind === 'track') {
    const p = TRACK_AUTO_PARAMS.find((x) => x.key === t.param);
    return p ? { ...p, fullLabel: p.label } : null;
  }
  if (t.kind === 'inst') {
    const p = instrumentAutoParams(track.instrument).find((x) => x.key === t.param);
    return p && track.instrument ? { ...p, fullLabel: `${INSTRUMENTS[track.instrument.type].label} · ${p.label}` } : null;
  }
  const slot = track.effects.find((s) => s.id === t.slotId);
  if (!slot) return null;
  const p = automatableParams(slot).find((x) => x.key === t.param);
  return p ? { ...p, fullLabel: `${EFFECT_LABELS[slot.type]} · ${p.label}` } : null;
}

/** The parameter's static (knob) value, used as the first point of a new lane. */
export function staticValue(track: Track, t: AutomationTarget): number | null {
  if (t.kind === 'track') return t.param === 'volumeDb' ? track.volumeDb : track.pan;
  if (t.kind === 'inst') return instrumentStaticValue(track.instrument, t.param);
  const slot = track.effects.find((s) => s.id === t.slotId);
  if (!slot) return null;
  if (slot.type === 'peq') {
    if (t.param === 'output') return slot.params.output;
    const bk = parseBandKey(t.param);
    const band = bk ? slot.params.bands[bk.band] : undefined;
    return bk && band ? band[bk.field] : null;
  }
  const v = (slot.params as unknown as Record<string, unknown>)[t.param];
  return typeof v === 'number' ? v : null;
}

/**
 * Value of a lane at a tick (linear between points; held before the first /
 * after the last). Several points on one tick form a step: at that tick the
 * value is the *last* of them, matching how the scheduler continues from it.
 */
export function valueAt(points: readonly AutomationPoint[], tick: number): number | null {
  const n = points.length;
  if (n === 0) return null;
  // index of the last point with p.tick <= tick
  let lo = -1;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as AutomationPoint).tick <= tick) lo = mid;
    else hi = mid;
  }
  if (lo < 0) return (points[0] as AutomationPoint).value;
  const a = points[lo] as AutomationPoint;
  const b = points[lo + 1];
  if (!b) return a.value;
  return a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
}

function clampToSpec(spec: NumericParamSpec, v: number): number {
  return Math.min(spec.max, Math.max(spec.min, v));
}

function sorted(points: AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.tick - b.tick);
}

export function createLane(target: AutomationTarget, initial: number, tick = 0): AutomationLane {
  return { id: createId('aut'), target, enabled: true, points: [{ id: createId('ap'), tick: Math.max(0, Math.round(tick)), value: initial }] };
}

export function addPoint(lane: AutomationLane, tick: number, value: number, spec: NumericParamSpec): [AutomationLane, string] {
  const id = createId('ap');
  const p = { id, tick: Math.max(0, Math.round(tick)), value: clampToSpec(spec, value) };
  return [{ ...lane, points: sorted([...lane.points, p]) }, id];
}

export function movePoint(lane: AutomationLane, id: string, tick: number, value: number, spec: NumericParamSpec): AutomationLane {
  return {
    ...lane,
    points: sorted(lane.points.map((p) => (p.id === id ? { ...p, tick: Math.max(0, Math.round(tick)), value: clampToSpec(spec, value) } : p))),
  };
}

export function deletePoint(lane: AutomationLane, id: string): AutomationLane {
  return { ...lane, points: lane.points.filter((p) => p.id !== id) };
}

/**
 * Write a value at `tick` the way a knob move does: replaces any points
 * between the previous write position and `tick` (so a sweep while playing
 * leaves a clean curve) and sets a point at `tick`.
 */
export function writeValue(lane: AutomationLane, fromTick: number | null, tick: number, value: number, spec: NumericParamSpec, mergeTicks = 0): AutomationLane {
  const t = Math.max(0, Math.round(tick));
  const lo = fromTick === null ? t - mergeTicks : Math.min(fromTick, t);
  const hi = fromTick === null ? t + mergeTicks : Math.max(fromTick, t);
  const keep = lane.points.filter((p) => p.tick < lo || p.tick > hi || (fromTick !== null && p.tick === fromTick));
  return { ...lane, points: sorted([...keep, { id: createId('ap'), tick: t, value: clampToSpec(spec, value) }]) };
}

/** Validate untrusted lanes against the track they belong to. */
export function sanitizeLanes(input: unknown, track: Track): AutomationLane[] {
  if (!Array.isArray(input)) return [];
  const out: AutomationLane[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const t = r.target as Record<string, unknown> | undefined;
    let target: AutomationTarget | null = null;
    if (t && t.kind === 'track' && (t.param === 'volumeDb' || t.param === 'pan')) target = { kind: 'track', param: t.param };
    if (t && t.kind === 'fx' && typeof t.slotId === 'string' && typeof t.param === 'string') target = { kind: 'fx', slotId: t.slotId, param: t.param };
    if (t && t.kind === 'inst' && typeof t.param === 'string') target = { kind: 'inst', param: t.param };
    if (!target) continue;
    // (effect lanes: any parameter the effect type has, not only the ones live right now)
    const fx = target.kind === 'fx' ? target : null;
    const slot = fx ? track.effects.find((s) => s.id === fx.slotId) : undefined;
    const info = fx ? (slot ? automatableParams(slot, true).find((p) => p.key === fx.param) : undefined) : targetInfo(track, target);
    if (!info) continue;
    if (out.some((l) => sameTarget(l.target, target))) continue;
    const pts = (Array.isArray(r.points) ? r.points : [])
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .filter((p) => typeof p.tick === 'number' && typeof p.value === 'number' && Number.isFinite(p.tick) && Number.isFinite(p.value))
      .map((p) => ({ id: typeof p.id === 'string' ? p.id : createId('ap'), tick: Math.max(0, Math.round(p.tick as number)), value: clampToSpec(info.spec, p.value as number) }));
    out.push({ id: typeof r.id === 'string' ? r.id : createId('aut'), target, enabled: r.enabled !== false, points: sorted(pts) });
  }
  return out;
}

/**
 * The lanes that act on the sound now: switched on, with points, and on a
 * parameter that's live. A lane on a Spectra EQ band that's off, or on Delay
 * Time while Sync is on, is paused: kept, but it must neither move the
 * parameter nor stop the static value from applying.
 */
export function liveLanes(track: Track): AutomationLane[] {
  return (track.automation ?? []).filter((l) => l.enabled && l.points.length > 0 && targetInfo(track, l.target) !== null);
}

/** Keys of effect params that are currently automated on a slot (for skipping static updates). */
export function automatedKeys(track: Track, slotId: string): Set<string> {
  const s = new Set<string>();
  for (const l of liveLanes(track)) if (l.target.kind === 'fx' && l.target.slotId === slotId) s.add(l.target.param);
  return s;
}

/** Instrument parameter keys with an active lane (the instrument keeps these under automation control). */
export function automatedInstKeys(track: Track): string[] {
  return liveLanes(track).filter((l) => l.target.kind === 'inst').map((l) => (l.target as { param: string }).param);
}

export function isTrackParamAutomated(track: Track, param: 'volumeDb' | 'pan'): boolean {
  return (track.automation ?? []).some((l) => l.enabled && l.points.length > 0 && l.target.kind === 'track' && l.target.param === param);
}
