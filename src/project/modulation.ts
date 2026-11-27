/**
 * Modulation (sidechain) routing: which parameters can be modulated and in
 * what units, route creation/validation, and cycle detection.
 *
 * Modulation is additive in each parameter's modulation unit:
 *   volume   → dB of ducking (a dedicated gain stage multiplies the signal)
 *   pan      → pan units (−1..1)
 *   EQ gains → dB
 *   frequencies → semitones (via the filters' detune params, so it's musical)
 *   threshold → dB, feedback → 0..1
 *   wet level (reverbs, delay, chorus, auto-filter, phaser) → dB on the wet
 *   signal, pre-delay / chorus depth → ms, chorus rate, auto-filter cutoff and
 *   phaser centre → octaves, EQ Q → Q units, Reverb Lite decay → seconds
 */
import { createId } from '../core/ids';
import { EFFECT_LABELS, peqHasGain } from '../audio/effects/specs';
import type { NumericParamSpec } from '../synth/params';
import { parseBandKey, sameTarget } from './automation';
import type { AutomationTarget, ModRoute, ModSourceKind, Project, Track } from './types';

export interface ModParamInfo {
  key: string;
  label: string;
  depth: NumericParamSpec;
}

const dbDepth = (range: number, def: number): NumericParamSpec => ({
  label: 'Depth',
  min: -range,
  max: range,
  default: def,
  curve: 'linear',
  bipolar: true,
  format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
});
const semiDepth: NumericParamSpec = {
  label: 'Depth',
  min: -48,
  max: 48,
  default: 12,
  curve: 'linear',
  bipolar: true,
  format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
};

const msDepth = (range: number, def: number): NumericParamSpec => ({
  label: 'Depth',
  min: -range,
  max: range,
  default: def,
  curve: 'linear',
  bipolar: true,
  format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(range < 20 ? 1 : 0)} ms`,
});
const octDepth: NumericParamSpec = {
  label: 'Depth',
  min: -3,
  max: 3,
  default: 1,
  curve: 'linear',
  bipolar: true,
  format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} oct`,
};
const qDepth: NumericParamSpec = {
  label: 'Depth',
  min: -12,
  max: 12,
  default: 2,
  curve: 'linear',
  bipolar: true,
  format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} Q`,
};
/** wet level of a send-style effect: dB on the wet signal only (ducked reverb / delay) */
const wetParam = (): ModParamInfo => ({ key: 'mix', label: 'Wet', depth: dbDepth(24, -12) });

export const MOD_SPECS = {
  attack: { label: 'Attack', min: 0.0005, max: 0.5, default: 0.004, curve: 'exp', format: (v: number) => `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` },
  release: { label: 'Release', min: 0.01, max: 2, default: 0.15, curve: 'exp', format: (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`) },
  threshold: { label: 'Thresh', min: -60, max: 0, default: -30, curve: 'linear', format: (v: number) => `${v.toFixed(0)} dB` },
  hold: { label: 'Hold', min: 0, max: 1, default: 0.03, curve: 'linear', format: (v: number) => `${Math.round(v * 1000)} ms` },
} satisfies Record<string, NumericParamSpec>;

export const TRACK_MOD_PARAMS: ModParamInfo[] = [
  { key: 'volumeDb', label: 'Volume', depth: dbDepth(48, -12) },
  {
    key: 'pan',
    label: 'Pan',
    depth: { label: 'Depth', min: -1, max: 1, default: 0.5, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` },
  },
];

/** Parameters of an effect that accept a modulation signal. */
export function modulatableEffectParams(track: Track, slotId: string): ModParamInfo[] {
  const slot = track.effects.find((s) => s.id === slotId);
  if (!slot) return [];
  switch (slot.type) {
    case 'eq':
      return [
        { key: 'lowGain', label: 'Low', depth: dbDepth(24, -6) },
        { key: 'midGain', label: 'Mid', depth: dbDepth(24, -6) },
        { key: 'midFreq', label: 'Mid Freq', depth: semiDepth },
        { key: 'highGain', label: 'High', depth: dbDepth(24, -6) },
      ];
    case 'peq': {
      const out: ModParamInfo[] = [];
      slot.params.bands.forEach((b, i) => {
        if (!b.enabled) return;
        out.push({ key: `b${i}.freq`, label: `Band ${i + 1} Freq`, depth: semiDepth });
        if (peqHasGain(b.type)) out.push({ key: `b${i}.gain`, label: `Band ${i + 1} Gain`, depth: dbDepth(24, -6) });
        // width of bells, notches and band-passes (cut filters' resonance is in other units)
        if (b.type === 'bell' || b.type === 'notch' || b.type === 'bandpass') out.push({ key: `b${i}.q`, label: `Band ${i + 1} Q`, depth: qDepth });
      });
      return out;
    }
    case 'compressor':
      return [{ key: 'threshold', label: 'Thresh', depth: dbDepth(30, -12) }];
    case 'delay':
      return [
        wetParam(),
        {
          key: 'feedback',
          label: 'Feedback',
          depth: { label: 'Depth', min: -0.5, max: 0.5, default: 0.3, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%` },
        },
      ];
    case 'reverb':
      return [wetParam(), { key: 'preDelay', label: 'Pre-delay', depth: msDepth(200, 40) }];
    case 'chorus':
      return [wetParam(), { key: 'rate', label: 'Rate', depth: octDepth }, { key: 'depth', label: 'Depth', depth: msDepth(10, 2) }];
    case 'autofilter':
      // the sidechain opens (or with negative depth closes) the filter, in octaves
      return [{ key: 'cutoff', label: 'Cutoff', depth: { ...octDepth, min: -6, max: 6, default: 2 } }, wetParam()];
    case 'phaser':
      // the sweep's centre in octaves (a kick can push the notches up), and the wet level
      return [{ key: 'center', label: 'Center', depth: { ...octDepth, min: -4, max: 4, default: 1 } }, wetParam()];
    case 'room':
      // decay in seconds: a negative depth chokes the tail on every hit (gated reverb)
      return [
        wetParam(),
        {
          key: 'decay',
          label: 'Decay',
          depth: { label: 'Depth', min: -6, max: 6, default: -1, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} s` },
        },
        { key: 'preDelay', label: 'Pre-delay', depth: msDepth(200, 40) },
      ];
  }
}

export function modParamInfo(track: Track, target: AutomationTarget): (ModParamInfo & { fullLabel: string }) | null {
  if (target.kind === 'track') {
    const p = TRACK_MOD_PARAMS.find((x) => x.key === target.param);
    return p ? { ...p, fullLabel: p.label } : null;
  }
  if (target.kind === 'inst') return null; // instrument params aren't sidechain targets (yet)
  const slot = track.effects.find((s) => s.id === target.slotId);
  if (!slot) return null;
  const p = modulatableEffectParams(track, target.slotId).find((x) => x.key === target.param);
  return p ? { ...p, fullLabel: `${EFFECT_LABELS[slot.type]} · ${p.label}` } : null;
}

export function isModulatable(track: Track, target: AutomationTarget): boolean {
  return modParamInfo(track, target) !== null;
}

/** Which source kinds a track offers: every track has audio; instrument tracks also have MIDI. */
export function sourceKinds(source: Track): ModSourceKind[] {
  return source.kind === 'instrument' ? ['midi', 'audio'] : ['audio'];
}

export function createRoute(track: Track, sourceTrackId: string, source: ModSourceKind, target: AutomationTarget): ModRoute | null {
  const info = modParamInfo(track, target);
  if (!info) return null;
  return {
    id: createId('mod'),
    sourceTrackId,
    source,
    target,
    depth: info.depth.default,
    attack: MOD_SPECS.attack.default,
    release: MOD_SPECS.release.default,
    threshold: MOD_SPECS.threshold.default,
    hold: MOD_SPECS.hold.default,
    note: null,
    invert: false,
    enabled: true,
  };
}

/**
 * Audio routes create real audio-graph edges (source track → target track's
 * parameter). Web Audio silences cycles without a delay, so an audio route is
 * only allowed if it doesn't close a loop. The duck (volume) stage sits after
 * the sidechain tap, so a track may duck itself from its own audio; any other
 * self-route is a cycle. MIDI routes are event-driven and never form cycles.
 */
export function wouldCreateCycle(project: Project, ownerTrackId: string, route: Pick<ModRoute, 'sourceTrackId' | 'source' | 'target'>): boolean {
  if (route.source !== 'audio') return false;
  if (route.sourceTrackId === ownerTrackId) {
    return !(route.target.kind === 'track' && route.target.param === 'volumeDb');
  }
  // edges: source → owner for every enabled audio route (excluding self-duck, which is safe)
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (from === to) return;
    let s = edges.get(from);
    if (!s) edges.set(from, (s = new Set()));
    s.add(to);
  };
  for (const t of project.tracks) for (const r of t.modulations) if (r.enabled && r.source === 'audio') add(r.sourceTrackId, t.id);
  add(route.sourceTrackId, ownerTrackId);
  // is there a path owner → … → source? (then source → owner closes a cycle)
  const seen = new Set<string>();
  const stack = [ownerTrackId];
  while (stack.length) {
    const n = stack.pop() as string;
    if (n === route.sourceTrackId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of edges.get(n) ?? []) stack.push(m);
  }
  return false;
}

function num(v: unknown, spec: NumericParamSpec): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : spec.default;
  return Math.min(spec.max, Math.max(spec.min, x));
}

/** Validate stored routes for every track (needs the whole project to check sources and cycles). */
export function sanitizeAllRoutes(project: Project, rawByTrack: unknown[]): void {
  const ids = new Set(project.tracks.map((t) => t.id));
  project.tracks.forEach((t) => (t.modulations = []));
  project.tracks.forEach((track, i) => {
    const raw = rawByTrack[i];
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const tg = r.target as Record<string, unknown> | undefined;
      let target: AutomationTarget | null = null;
      if (tg?.kind === 'track' && (tg.param === 'volumeDb' || tg.param === 'pan')) target = { kind: 'track', param: tg.param };
      if (tg?.kind === 'fx' && typeof tg.slotId === 'string' && typeof tg.param === 'string') target = { kind: 'fx', slotId: tg.slotId, param: tg.param };
      const sourceTrackId = typeof r.sourceTrackId === 'string' ? r.sourceTrackId : '';
      const source: ModSourceKind = r.source === 'midi' ? 'midi' : 'audio';
      if (!target || !ids.has(sourceTrackId)) continue;
      const info = modParamInfo(track, target);
      const src = project.tracks.find((t) => t.id === sourceTrackId);
      if (!info || !src || !sourceKinds(src).includes(source)) continue;
      const route: ModRoute = {
        id: typeof r.id === 'string' ? r.id : createId('mod'),
        sourceTrackId,
        source,
        target,
        depth: num(r.depth, info.depth),
        attack: num(r.attack, MOD_SPECS.attack),
        release: num(r.release, MOD_SPECS.release),
        threshold: num(r.threshold, MOD_SPECS.threshold),
        hold: num(r.hold, MOD_SPECS.hold),
        note: source === 'midi' && typeof r.note === 'number' && r.note >= 0 && r.note <= 127 ? Math.round(r.note) : null,
        invert: r.invert === true,
        enabled: r.enabled !== false,
      };
      if (track.modulations.some((m) => m.sourceTrackId === sourceTrackId && m.source === source && sameTarget(m.target, target))) continue;
      if (wouldCreateCycle(project, track.id, route)) continue;
      track.modulations.push(route);
    }
  });
}

/** Keys of effect params on a slot that have active modulation (for the knob indicator). */
export function routesFor(track: Track, target: AutomationTarget): ModRoute[] {
  return track.modulations.filter((m) => sameTarget(m.target, target));
}

export { parseBandKey };
