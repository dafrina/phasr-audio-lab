/**
 * Keyforge editor: preset browser grouped by engine, engine tabs, a knob
 * panel generated from the engine's parameter specs (every knob can be
 * automated / sidechained via right-click), drawbars for the organ and the
 * shared keyboard strip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Save, Trash2, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { KEYS_ENGINES, KEYS_ENGINE_TYPES, sanitizeKeysParams, type KeysEngineType, type KeysParamSpec } from '../../keys/params';
import { KEYS_PRESETS, type KeysPreset } from '../../keys/presets';
import type { InstrumentConfig } from '../../project/types';
import { getProject, setInstrumentConfig, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { AutoKnob, useAutomatedValue } from '../common/AutoKnob';
import { Meter } from '../common/Meter';
import { Section } from '../common/controls';
import { FINE } from '../common/HSlider';
import { KeyboardStrip, useComputerKeyboard } from '../synth/KeyboardStrip';
import { useWindowZ } from '../common/windowStack';

type KeysConfig = Extract<InstrumentConfig, { type: 'keys' }>;

const WIN_W = 1040;
const USER_KEY = 'phasr.keysPresets.v1';

function loadUserPresets(): KeysPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r: unknown) => {
      const o = r as Partial<KeysPreset> | null;
      if (!o || typeof o.name !== 'string' || typeof o.engine !== 'string' || !(o.engine in KEYS_ENGINES)) return [];
      const engine = o.engine as KeysEngineType;
      return [{ name: o.name, engine, category: 'User', params: sanitizeKeysParams(engine, o.params) }];
    });
  } catch {
    return [];
  }
}

function saveUserPresets(list: KeysPreset[]): boolean {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9);
}

/** drawbar colours of the classic layout: brown sub-harmonics, white octaves, black other harmonics */
const DRAWBAR_COLORS = ['#8b4a2b', '#8b4a2b', '#e9e4da', '#e9e4da', '#1b1b1f', '#e9e4da', '#1b1b1f', '#1b1b1f', '#e9e4da'];

export function KeysWindow({ trackId }: { trackId: string }) {
  const win = useWindowZ('keys');
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 620) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const [userPresets, setUserPresets] = useState<KeysPreset[]>(() => loadUserPresets());

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    engine.sustain(trackId, false);
    setUi({ synthTrackId: null });
  }, [trackId, setUi]);
  const kb = useComputerKeyboard(trackId, close, 0.8, 'keys');

  useEffect(() => {
    if (!track || track.instrument?.type !== 'keys') setUi({ synthTrackId: null });
  }, [track, setUi]);
  useEffect(() => {
    root.current?.focus();
  }, [trackId]);

  const allPresets = useMemo(() => [...KEYS_PRESETS, ...userPresets], [userPresets]);

  if (!track || track.instrument?.type !== 'keys') return null;
  const inst = track.instrument;
  const eng = KEYS_ENGINES[inst.engine];
  const current = allPresets.find((p) => p.name === inst.presetName && p.engine === inst.engine);
  const modified = current ? !sameParams(current.params, inst.params) : true;
  const isUser = !!current && userPresets.includes(current);

  const latest = (): KeysConfig => {
    const i = getProject().tracks.find((t) => t.id === trackId)?.instrument;
    return i?.type === 'keys' ? i : inst;
  };
  const setParam = (key: string, v: number) => {
    const c = latest();
    setInstrumentConfig(trackId, { ...c, params: { ...c.params, [key]: v } }, 'Edit Keyforge', { coalesce: `keys-${trackId}-${key}` });
  };
  const loadPreset = (p: KeysPreset) => setInstrumentConfig(trackId, { type: 'keys', engine: p.engine, params: { ...p.params }, presetName: p.name }, `Keyforge: ${p.name}`);
  const step = (dir: 1 | -1) => {
    const idx = allPresets.findIndex((p) => p === current);
    const next = allPresets[(idx + dir + allPresets.length) % allPresets.length];
    if (next) loadPreset(next);
  };
  const savePreset = () => {
    const name = prompt('Save Keyforge preset as:', modified || !isUser ? `${inst.presetName} (User)` : inst.presetName)?.trim();
    if (!name) return;
    if (KEYS_PRESETS.some((p) => p.name === name)) {
      uiToast('error', `"${name}" is a factory preset name. Choose another name.`);
      return;
    }
    if (userPresets.some((p) => p.name === name) && !confirm(`Overwrite user preset "${name}"?`)) return;
    const c = latest();
    const next = [...userPresets.filter((p) => p.name !== name), { name, engine: c.engine, category: 'User', params: { ...c.params } }];
    if (!saveUserPresets(next)) {
      uiToast('error', 'Could not save the preset: browser storage is unavailable or full.');
      return;
    }
    setUserPresets(next);
    setInstrumentConfig(trackId, { ...c, presetName: name }, 'Save preset', { skipHistory: true });
    uiToast('info', `Saved preset "${name}".`);
  };
  const deleteUserPreset = () => {
    if (!current || !isUser || !confirm(`Delete user preset "${current.name}"?`)) return;
    const next = userPresets.filter((p) => p !== current);
    saveUserPresets(next);
    setUserPresets(next);
  };

  // group parameters as declared in the spec list
  const groups: { name: string; specs: KeysParamSpec[] }[] = [];
  for (const s of eng.params) {
    const g = groups.find((x) => x.name === s.group);
    if (g) g.specs.push(s);
    else groups.push({ name: s.group, specs: [s] });
  }

  const knob = (s: KeysParamSpec, color = eng.color) =>
    s.choices ? (
      <ChoiceParam key={s.key} trackId={trackId} spec={s} value={inst.params[s.key] ?? s.default} color={color} onChange={(v) => setParam(s.key, v)} />
    ) : (
      <AutoKnob key={s.key} trackId={trackId} target={{ kind: 'inst', param: s.key }} spec={s} value={inst.params[s.key] ?? s.default} color={color} onChange={(v) => setParam(s.key, v)} />
    );

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-testid="keys-window"
      onPointerDownCapture={win.raise}
      style={{ left: pos.x, top: pos.y, width: WIN_W, zIndex: win.z }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70 outline-none"
    >
      {/* ---------- header ---------- */}
      <div
        className="flex h-[43px] shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-panel-3 to-panel px-3"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input')) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          dragWin.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragWin.current;
          if (!d) return;
          setPos({ x: Math.min(window.innerWidth - 120, Math.max(-900, e.clientX - d.dx)), y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)) });
        }}
        onPointerUp={() => (dragWin.current = null)}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="h-3.5 w-1 -skew-x-[20deg]" style={{ background: eng.color }} />
          <span className="text-[14px] font-bold tracking-[0.18em] text-fg">KEYFORGE</span>
          <span className="text-[10px] uppercase tracking-wider text-muted">· {track.name}</span>
        </div>
        <div className="ml-4 flex items-center gap-1">
          <button type="button" title="Previous preset" onClick={() => step(-1)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
            <ChevronLeft size={15} />
          </button>
          <select
            value={current ? `${current.engine}:${current.name}` : ''}
            onChange={(e) => {
              const p = allPresets.find((x) => `${x.engine}:${x.name}` === e.target.value);
              if (p) loadPreset(p);
            }}
            className="h-6 w-64"
            title="Preset"
            data-testid="keys-preset"
          >
            {!current && <option value="">{inst.presetName} (custom)</option>}
            {KEYS_ENGINE_TYPES.map((e) => (
              <optgroup key={e} label={KEYS_ENGINES[e].label}>
                {allPresets
                  .filter((p) => p.engine === e)
                  .map((p) => (
                    <option key={`${e}:${p.name}`} value={`${e}:${p.name}`}>
                      {p.name}
                      {p.category === 'User' ? ' (user)' : ` — ${p.category}`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <button type="button" title="Next preset" onClick={() => step(1)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
            <ChevronRight size={15} />
          </button>
          {modified && <span className="px-1 text-[10px] text-warn" title="Parameters differ from the saved preset">edited</span>}
          <button type="button" title="Save as user preset" onClick={savePreset} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2">
            <Save size={14} /> Save
          </button>
          {isUser && (
            <button type="button" title="Delete this user preset" onClick={deleteUserPreset} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 text-muted hover:bg-line-2 hover:text-bad">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1" role="tablist" aria-label="Engine">
          {KEYS_ENGINE_TYPES.map((e) => {
            const on = e === inst.engine;
            return (
              <button
                key={e}
                type="button"
                role="tab"
                aria-selected={on}
                title={`${KEYS_ENGINES[e].label}: ${KEYS_ENGINES[e].description}`}
                onClick={() => {
                  if (on) return;
                  const first = KEYS_PRESETS.find((p) => p.engine === e);
                  if (first) loadPreset(first);
                }}
                className={`h-6 rounded px-2 text-[10px] font-semibold uppercase tracking-wider ${on ? 'text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
                style={on ? { background: KEYS_ENGINES[e].color } : undefined}
              >
                {KEYS_ENGINES[e].label}
              </button>
            );
          })}
          <button type="button" title="Close (Esc)" onClick={close} className="ml-2 flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="px-3 pt-1.5 text-[10px] text-dim">{eng.description}</div>

      {/* ---------- parameters ---------- */}
      <div className="flex flex-wrap items-start gap-1.5 p-2">
        {groups.map((g) =>
          g.name === 'Drawbars' ? (
            <Section key={g.name} title="Drawbars">
              <div className="flex gap-1">
                {g.specs.map((s, i) => (
                  <Drawbar key={s.key} trackId={trackId} spec={s} value={inst.params[s.key] ?? s.default} color={DRAWBAR_COLORS[i] ?? '#ddd'} onChange={(v) => setParam(s.key, v)} />
                ))}
              </div>
            </Section>
          ) : (
            <Section key={g.name} title={g.name}>
              <div className="flex items-end gap-1.5">
                {g.specs.map((s) => knob(s))}
                {g.name === 'Output' && <Meter source={trackId} width={8} height={44} />}
              </div>
            </Section>
          ),
        )}
      </div>

      <KeyboardStrip trackId={trackId} kb={kb} low={inst.engine === 'organ' ? 36 : 28} high={inst.engine === 'organ' ? 96 : 100} />
    </div>
  );
}

/** two/three-way switch for stepped parameters (perc on/off, rotor speed, poly/mono) */
function ChoiceParam({ trackId, spec, value, color, onChange }: { trackId: string; spec: KeysParamSpec; value: number; color: string; onChange: (v: number) => void }) {
  const auto = useAutomatedValue(trackId, { kind: 'inst', param: spec.key }, value);
  const choices = spec.choices ?? [];
  // nearest choice to the (possibly automated) value
  const cur = choices.reduce((best, c) => (Math.abs(c.value - auto.value) < Math.abs(best.value - auto.value) ? c : best), choices[0] ?? { value, label: '' });
  return (
    <div className="flex flex-col items-center gap-1" title={auto.automated ? `${spec.label} (automated)` : spec.label}>
      <div className="flex flex-col overflow-hidden rounded border border-line">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            className={`h-[17px] min-w-[38px] px-1.5 text-[10px] ${cur.value === c.value ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
            style={cur.value === c.value ? { background: color } : undefined}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className={`max-w-[56px] truncate text-[9px] uppercase tracking-wide ${auto.automated ? 'text-accent-hi' : 'text-muted'}`}>{spec.label}</div>
    </div>
  );
}

/** A pull-out drawbar: drag down to pull out (louder), with an automatable knob below it. */
function Drawbar({ trackId, spec, value, color, onChange }: { trackId: string; spec: KeysParamSpec; value: number; color: string; onChange: (v: number) => void }) {
  const auto = useAutomatedValue(trackId, { kind: 'inst', param: spec.key }, value);
  const drag = useRef<{ y: number; v: number } | null>(null);
  const H = 96;
  const shown = auto.value;
  const pulled = (shown / 8) * (H - 18);
  const dark = color === '#1b1b1f' || color === '#8b4a2b';
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative w-7 cursor-ns-resize overflow-hidden rounded-sm bg-base"
        style={{ height: H }}
        title={`${spec.label}: ${shown.toFixed(1)} — drag down to pull out (Shift for fine), double-click to push in`}
        onDoubleClick={() => onChange(0)}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: value };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          // relative, re-anchored every move so pressing or releasing Shift mid-drag doesn't jump
          const v = Math.min(8, Math.max(0, d.v + ((e.clientY - d.y) / (H - 18)) * 8 * (e.shiftKey ? FINE : 1)));
          drag.current = { y: e.clientY, v };
          const r = Math.round(v * 10) / 10;
          if (r !== value) onChange(r);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {/* scale */}
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="absolute left-0 right-0 border-t border-line/60" style={{ top: 9 + (i / 8) * (H - 18) }} />
        ))}
        <div className="absolute left-1 right-1 top-0 rounded-b-sm" style={{ height: 8 + pulled, background: color, opacity: auto.automated ? 0.85 : 1 }}>
          {pulled >= 12 && <div className={`absolute bottom-0.5 left-0 right-0 text-center font-mono text-[10px] font-bold ${dark ? 'text-white/85' : 'text-black/70'}`}>{Math.round(shown)}</div>}
        </div>
      </div>
      <AutoKnob trackId={trackId} target={{ kind: 'inst', param: spec.key }} spec={spec} value={value} size={26} color={dark ? '#b07a5a' : '#cfcac0'} onChange={onChange} />
    </div>
  );
}
