import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Power, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import {
  FILTER_TYPES,
  LFO_TARGETS,
  LFO_WAVEFORMS,
  OSC_WAVEFORMS,
  PARAM_SPECS,
  PHASE_MODES,
  defaultPatch,
  type EnvelopeParams,
  type OscParams,
  type TriOscPatch,
} from '../../synth/params';
import { FACTORY_PRESETS, loadUserPresets, makeUserPreset, saveUserPresets, type TriOscPreset } from '../../synth/presets';
import { getProject, setInstrumentPatch, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { AutoKnob } from '../common/AutoKnob';
import { Meter } from '../common/Meter';
import { Section, Segmented } from '../common/controls';
import { BendWheel, PianoKeyboard } from './PianoKeyboard';
import { EnvelopeGraph, WaveIcon, WaveformPreview } from './visuals';

/** Computer-keyboard note map (physical key codes, layout independent). Values are semitones from the base C. */
const KEY_MAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

const WIN_W = 1120;

const OSC_COLORS = ['#9b8aff', '#22d3ee', '#f472b6'];

type SectionKey = 'ampEnv' | 'filter' | 'filterEnv' | 'lfo' | 'voice';

function samePatch(a: TriOscPatch, b: TriOscPatch): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SynthWindow({ trackId }: { trackId: string }) {
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 690) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const [userPresets, setUserPresets] = useState<TriOscPreset[]>(() => loadUserPresets());
  const [octave, setOctave] = useState(4); // base C = C4 (MIDI 60)
  const [sustain, setSustain] = useState(false);
  const [kbActive, setKbActive] = useState<ReadonlySet<number>>(new Set());
  const kbHeld = useRef(new Map<string, { note: number; id: number }>());

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    engine.sustain(trackId, false);
    setUi({ synthTrackId: null });
  }, [trackId, setUi]);

  // close if the track disappears (deleted / undo) or is no longer a TriOsc
  useEffect(() => {
    if (!track || track.instrument?.type !== 'triosc') setUi({ synthTrackId: null });
  }, [track, setUi]);

  useEffect(() => {
    root.current?.focus();
    const held = kbHeld.current;
    return () => {
      // never leave notes hanging when the window closes or switches track
      for (const h of held.values()) engine.previewNoteOff(trackId, h.id);
      held.clear();
      engine.sustain(trackId, false);
    };
  }, [trackId]);

  const allPresets = useMemo(() => [...FACTORY_PRESETS, ...userPresets], [userPresets]);

  if (!track || track.instrument?.type !== 'triosc') return null;
  const patch = track.instrument.patch;
  const presetName = track.instrument.presetName;
  const current = allPresets.find((p) => p.name === presetName);
  const modified = current ? !samePatch(current.patch, patch) : true;

  // ---- patch editing helpers (always read the latest patch from the store) ----
  const latest = (): TriOscPatch => {
    const inst = getProject().tracks.find((t) => t.id === trackId)?.instrument;
    return inst?.type === 'triosc' ? inst.patch : patch;
  };
  const latestName = (): string => getProject().tracks.find((t) => t.id === trackId)?.instrument?.presetName ?? presetName;
  const update = (fn: (p: TriOscPatch) => TriOscPatch, key: string) =>
    setInstrumentPatch(trackId, fn(latest()), latestName(), { coalesce: `synth-${trackId}-${key}` });
  const setOsc = (i: number, part: Partial<OscParams>, key: string) =>
    update(
      (p) => ({ ...p, oscs: p.oscs.map((o, j) => (j === i ? { ...o, ...part } : o)) as TriOscPatch['oscs'] }),
      `osc${i}-${key}`,
    );
  const setSec = <K extends SectionKey>(k: K, part: Partial<TriOscPatch[K]>, key: string) =>
    update((p) => ({ ...p, [k]: { ...p[k], ...part } }), `${k}-${key}`);

  const loadPreset = (p: TriOscPreset) => setInstrumentPatch(trackId, structuredClone(p.patch), p.name);
  const step = (dir: 1 | -1) => {
    const idx = allPresets.findIndex((p) => p.name === presetName);
    const next = allPresets[(idx + dir + allPresets.length) % allPresets.length];
    if (next) loadPreset(next);
  };
  const savePreset = () => {
    const name = prompt('Save preset as:', modified || current?.factory ? `${presetName} (User)` : presetName)?.trim();
    if (!name) return;
    if (FACTORY_PRESETS.some((p) => p.name === name)) {
      uiToast('error', `"${name}" is a factory preset name. Choose another name.`);
      return;
    }
    const exists = userPresets.some((p) => p.name === name);
    if (exists && !confirm(`Overwrite user preset "${name}"?`)) return;
    const next = [...userPresets.filter((p) => p.name !== name), makeUserPreset(name, latest())];
    if (!saveUserPresets(next)) {
      uiToast('error', 'Could not save the preset: browser storage is unavailable or full.');
      return;
    }
    setUserPresets(next);
    setInstrumentPatch(trackId, latest(), name, { skipHistory: true });
    uiToast('info', `Saved preset "${name}".`);
  };
  const deleteUserPreset = () => {
    if (!current || current.factory) return;
    if (!confirm(`Delete user preset "${current.name}"?`)) return;
    const next = userPresets.filter((p) => p.name !== current.name);
    saveUserPresets(next);
    setUserPresets(next);
  };

  // ---- computer keyboard ----
  const base = (octave + 1) * 12;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      e.preventDefault();
      setOctave((o) => Math.min(8, Math.max(0, o + (e.code === 'BracketRight' ? 1 : -1))));
      return;
    }
    if (e.code === 'Escape') return close();
    const off = KEY_MAP[e.code];
    if (off === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || kbHeld.current.has(e.code)) return;
    const note = base + off;
    if (note > 127) return;
    const id = engine.previewNoteOn(trackId, note, 0.8);
    if (id === null) return;
    kbHeld.current.set(e.code, { note, id });
    setKbActive(new Set([...kbHeld.current.values()].map((h) => h.note)));
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const h = kbHeld.current.get(e.code);
    if (!h) return;
    engine.previewNoteOff(trackId, h.id);
    kbHeld.current.delete(e.code);
    setKbActive(new Set([...kbHeld.current.values()].map((x) => x.note)));
  };
  const releaseKb = () => {
    for (const h of kbHeld.current.values()) engine.previewNoteOff(trackId, h.id);
    kbHeld.current.clear();
    setKbActive(new Set());
  };

  return (
    <div
      ref={root}
      tabIndex={-1}
      data-capture-keys
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) releaseKb();
      }}
      style={{ left: pos.x, top: pos.y, width: WIN_W }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70 outline-none"
    >
      {/* ---------- header ---------- */}
      <div
        className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-panel-3 to-panel px-3"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input')) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          dragWin.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragWin.current;
          if (!d) return;
          setPos({
            x: Math.min(window.innerWidth - 120, Math.max(-900, e.clientX - d.dx)),
            y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)),
          });
        }}
        onPointerUp={() => (dragWin.current = null)}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="h-3.5 w-1 -skew-x-[20deg] bg-accent" />
          <span className="text-[14px] font-bold tracking-[0.18em] text-fg">TRIOSC</span>
          <span className="text-[10px] uppercase tracking-wider text-muted">· {track.name}</span>
        </div>
        <div className="ml-4 flex items-center gap-1">
          <button type="button" title="Previous preset" onClick={() => step(-1)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
            <ChevronLeft size={13} />
          </button>
          <select
            value={current ? current.name : ''}
            onChange={(e) => {
              const p = allPresets.find((x) => x.name === e.target.value);
              if (p) loadPreset(p);
            }}
            className="h-6 w-48"
            title="Preset"
          >
            {!current && <option value="">{presetName} (custom)</option>}
            <optgroup label="Factory">
              {FACTORY_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.category}
                </option>
              ))}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="User">
                {userPresets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" title="Next preset" onClick={() => step(1)} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 hover:bg-line-2">
            <ChevronRight size={13} />
          </button>
          {modified && <span className="px-1 text-[10px] text-warn" title="Patch differs from the saved preset">edited</span>}
          <button type="button" title="Save as user preset" onClick={savePreset} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2">
            <Save size={12} /> Save
          </button>
          {current && !current.factory && (
            <button type="button" title="Delete this user preset" onClick={deleteUserPreset} className="flex h-6 w-6 items-center justify-center rounded bg-panel-3 text-muted hover:bg-line-2 hover:text-bad">
              <Trash2 size={12} />
            </button>
          )}
          <button
            type="button"
            title="Init: reset to a single sine oscillator"
            onClick={() => setInstrumentPatch(trackId, defaultPatch(), 'Init Sine')}

            className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2"
          >
            <RotateCcw size={12} /> Init
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5" title="Classic = raw, aliasing waveforms. HQ = band-limited (PolyBLEP) oscillators.">
            <span className="text-[9px] uppercase tracking-wider text-muted">Quality</span>
            <Segmented value={patch.quality} options={['classic', 'hq'] as const} onChange={(q) => update((p) => ({ ...p, quality: q }), 'quality')} />
          </div>
          <button
            type="button"
            title="AM mode: oscillator 3 modulates the amplitude of oscillators 1 + 2 (its level sets the depth) instead of being heard"
            onClick={() => update((p) => ({ ...p, amMode: !p.amMode }), 'am')}
            className={`h-6 rounded px-2 text-[10px] font-semibold uppercase tracking-wider ${patch.amMode ? 'bg-accent text-white' : 'bg-panel-3 text-muted hover:text-fg'}`}
          >
            3 → AM
          </button>
          <button type="button" title="Close (Esc)" onClick={close} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ---------- oscillators ---------- */}
      <div className="flex flex-col gap-1.5 p-2">
        {patch.oscs.map((o, i) => (
          <OscRow key={i} trackId={trackId} index={i} osc={o} am={patch.amMode && i === 2} onChange={(part, key) => setOsc(i, part, key)} />
        ))}
      </div>

      {/* ---------- envelopes / filter / lfo / voice ---------- */}
      <div className="grid grid-cols-[auto_auto_auto_auto_1fr] gap-1.5 px-2 pb-2">
        <Section title="Amp Envelope">
          <EnvBlock trackId={trackId} prefix="ampEnv" env={patch.ampEnv} color="#9b8aff" onChange={(part, key) => setSec('ampEnv', part, key)} />
        </Section>
        <Section
          title="Filter"
          right={
            <button
              type="button"
              title={patch.filter.enabled ? 'Bypass filter' : 'Enable filter'}
              onClick={() => setSec('filter', { enabled: !patch.filter.enabled }, 'enabled')}
              className={`flex h-4 w-4 items-center justify-center rounded ${patch.filter.enabled ? 'bg-accent text-white' : 'bg-panel-3 text-muted'}`}
            >
              <Power size={10} />
            </button>
          }
        >
          <div className={`flex flex-col gap-1.5 ${patch.filter.enabled ? '' : 'opacity-40'}`}>
            <Segmented
              value={patch.filter.type}
              options={FILTER_TYPES}
              onChange={(t) => setSec('filter', { type: t }, 'type')}
              render={(t) => (t === 'lowpass' ? 'LP' : t === 'highpass' ? 'HP' : 'BP')}
            />
            <div className="flex gap-1.5">
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'filter.cutoff' }} spec={PARAM_SPECS.cutoff} value={patch.filter.cutoff} onChange={(v) => setSec('filter', { cutoff: v }, 'cutoff')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'filter.resonance' }} spec={PARAM_SPECS.resonance} value={patch.filter.resonance} onChange={(v) => setSec('filter', { resonance: v }, 'res')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'filter.envAmount' }} spec={PARAM_SPECS.envAmount} value={patch.filter.envAmount} onChange={(v) => setSec('filter', { envAmount: v }, 'env')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'filter.keyTrack' }} spec={PARAM_SPECS.keyTrack} value={patch.filter.keyTrack} onChange={(v) => setSec('filter', { keyTrack: v }, 'kt')} />
            </div>
          </div>
        </Section>
        <Section title="Filter Envelope">
          <div className={patch.filter.enabled ? '' : 'opacity-40'}>
            <EnvBlock trackId={trackId} prefix="filterEnv" env={patch.filterEnv} color="#22d3ee" onChange={(part, key) => setSec('filterEnv', part, key)} />
          </div>
        </Section>
        <Section title="LFO">
          <div className="flex flex-col gap-1.5">
            <Segmented value={patch.lfo.waveform} options={LFO_WAVEFORMS} onChange={(w) => setSec('lfo', { waveform: w }, 'wf')} render={(w) => <WaveIcon waveform={w} size={14} />} />
            <div className="flex items-end gap-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] uppercase tracking-wide text-muted">Target</span>
                <select value={patch.lfo.target} onChange={(e) => setSec('lfo', { target: e.target.value as TriOscPatch['lfo']['target'] }, 'target')} title="LFO destination">
                  {LFO_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {t === 'off' ? 'Off' : t === 'pitch' ? 'Pitch' : t === 'cutoff' ? 'Cutoff' : 'Amp'}
                    </option>
                  ))}
                </select>
              </div>
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'lfo.rate' }} spec={PARAM_SPECS.lfoRate} value={patch.lfo.rate} disabled={patch.lfo.target === 'off'} onChange={(v) => setSec('lfo', { rate: v }, 'rate')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'lfo.depth' }} spec={PARAM_SPECS.lfoDepth} value={patch.lfo.depth} disabled={patch.lfo.target === 'off'} onChange={(v) => setSec('lfo', { depth: v }, 'depth')} />
            </div>
          </div>
        </Section>
        <Section title="Voice">
          <div className="flex items-start gap-2">
            <div className="flex flex-col gap-1.5">
              <Segmented value={patch.voice.mode} options={['poly', 'mono'] as const} onChange={(m) => setSec('voice', { mode: m }, 'mode')} />
              <button
                type="button"
                title="Legato (mono): overlapping notes change pitch without retriggering envelopes"
                disabled={patch.voice.mode !== 'mono'}
                onClick={() => setSec('voice', { legato: !patch.voice.legato }, 'legato')}
                className={`h-5 rounded px-1.5 text-[10px] uppercase tracking-wide disabled:opacity-35 ${patch.voice.legato ? 'bg-accent text-white' : 'bg-panel-3 text-muted'}`}
              >
                Legato
              </button>
            </div>
            <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'voice.glide' }} spec={PARAM_SPECS.glide} value={patch.voice.glide} onChange={(v) => setSec('voice', { glide: v }, 'glide')} title={`Portamento: ${PARAM_SPECS.glide.format(patch.voice.glide)}`} />
            <Knob spec={PARAM_SPECS.polyphony} value={patch.voice.polyphony} disabled={patch.voice.mode === 'mono'} onChange={(v) => setSec('voice', { polyphony: v }, 'poly')} />
            <Knob spec={PARAM_SPECS.bendRange} value={patch.voice.bendRange} onChange={(v) => setSec('voice', { bendRange: v }, 'bend')} />
            <Knob spec={PARAM_SPECS.velocitySens} value={patch.voice.velocitySens} onChange={(v) => setSec('voice', { velocitySens: v }, 'vel')} />
            <div className="mx-1 h-12 w-px self-center bg-line" />
            <AutoKnob trackId={trackId} target={{ kind: 'inst', param: 'master' }} spec={PARAM_SPECS.master} value={patch.master} size={40} onChange={(v) => update((p) => ({ ...p, master: v }), 'master')} />
            <Meter source={trackId} width={8} height={48} />
          </div>
        </Section>
      </div>

      {/* ---------- keyboard ---------- */}
      <div className="flex items-stretch gap-2 border-t border-line bg-panel-2 px-2 py-2">
        <div className="flex flex-col justify-between gap-1">
          <div className="flex items-center gap-1">
            <button type="button" title="Octave down ([)" onClick={() => setOctave((o) => Math.max(0, o - 1))} className="h-5 w-5 rounded bg-panel-3 text-[11px] hover:bg-line-2">
              −
            </button>
            <span className="w-10 text-center font-mono text-[10px] text-muted" title="Computer keyboard base octave">
              C{octave}
            </span>
            <button type="button" title="Octave up (])" onClick={() => setOctave((o) => Math.min(8, o + 1))} className="h-5 w-5 rounded bg-panel-3 text-[11px] hover:bg-line-2">
              +
            </button>
          </div>
          <button
            type="button"
            title="Sustain pedal (latching)"
            onClick={() => {
              const on = !sustain;
              setSustain(on);
              engine.sustain(trackId, on);
            }}
            className={`h-5 rounded px-1.5 text-[10px] uppercase tracking-wide ${sustain ? 'bg-accent text-white' : 'bg-panel-3 text-muted'}`}
          >
            Sustain
          </button>
          <div className="max-w-[92px] text-[9px] leading-tight text-dim">Keys Z–M / Q–P play · [ ] octave</div>
        </div>
        <BendWheel onChange={(v) => engine.pitchBend(trackId, v)} />
        <div className="flex-1">
          <PianoKeyboard
            low={36}
            high={96}
            externalActive={kbActive}
            onNoteOn={(n, v) => engine.previewNoteOn(trackId, n, v)}
            onNoteOff={(_n, id) => engine.previewNoteOff(trackId, id)}
          />
        </div>
      </div>
    </div>
  );
}

function OscRow({ trackId, index, osc, am, onChange }: { trackId: string; index: number; osc: OscParams; am: boolean; onChange: (p: Partial<OscParams>, key: string) => void }) {
  const color = OSC_COLORS[index] ?? '#9b8aff';
  const on = osc.enabled;
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5">
      <button
        type="button"
        title={on ? `Disable oscillator ${index + 1}` : `Enable oscillator ${index + 1}`}
        onClick={() => onChange({ enabled: !on }, 'enabled')}
        className="flex w-9 flex-col items-center gap-0.5"
      >
        <span className="font-mono text-[16px] font-bold leading-none" style={{ color: on ? color : '#4a4a60' }}>
          {index + 1}
        </span>
        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${on ? 'bg-ok/20 text-ok' : 'bg-panel-3 text-dim'}`}>
          <Power size={8} />
        </span>
      </button>
      <div className={`flex items-center gap-2 ${on ? '' : 'opacity-40'}`}>
        <div className="grid grid-cols-3 gap-0.5">
          {OSC_WAVEFORMS.map((w) => (
            <button
              key={w}
              type="button"
              title={w[0]?.toUpperCase() + w.slice(1)}
              onClick={() => onChange({ waveform: w }, 'wf')}
              className={`flex h-[18px] w-7 items-center justify-center rounded ${osc.waveform === w ? 'text-white' : 'bg-panel-3 text-muted hover:text-fg'}`}
              style={osc.waveform === w ? { background: color } : undefined}
            >
              <WaveIcon waveform={w} size={16} />
            </button>
          ))}
        </div>
        <WaveformPreview waveform={osc.waveform} pulseWidth={osc.pulseWidth} phase={osc.startPhase} enabled={on} color={color} />
        <div className="flex items-center gap-1.5">
          <Knob spec={PARAM_SPECS.coarse} value={osc.coarse} color={color} onChange={(v) => onChange({ coarse: v }, 'coarse')} />
          <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `osc${index}.fine` }} spec={PARAM_SPECS.fine} value={osc.fine} color={color} onChange={(v) => onChange({ fine: v }, 'fine')} />
          <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `osc${index}.level` }} spec={PARAM_SPECS.level} value={osc.level} color={color} label={am ? 'AM Depth' : 'Level'} onChange={(v) => onChange({ level: v }, 'level')} />
          <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `osc${index}.pan` }} spec={PARAM_SPECS.pan} value={osc.pan} color={color} disabled={am} onChange={(v) => onChange({ pan: Math.abs(v) < 0.02 ? 0 : v }, 'pan')} />
          <div className="mx-0.5 h-8 w-px bg-line" />
          <Knob spec={PARAM_SPECS.stereoDetune} value={osc.stereoDetune} color={color} onChange={(v) => onChange({ stereoDetune: v }, 'sdet')} title={`Stereo detune: ${PARAM_SPECS.stereoDetune.format(osc.stereoDetune)} spread between left and right`} />
          <Knob spec={PARAM_SPECS.stereoPhase} value={osc.stereoPhase} color={color} onChange={(v) => onChange({ stereoPhase: v }, 'sphs')} title={`Stereo phase offset of the right channel: ${PARAM_SPECS.stereoPhase.format(osc.stereoPhase)}`} />
          <Knob spec={PARAM_SPECS.startPhase} value={osc.startPhase} color={color} disabled={osc.phaseMode !== 'reset'} onChange={(v) => onChange({ startPhase: v }, 'phase')} title={`Start phase on note-on (reset mode): ${PARAM_SPECS.startPhase.format(osc.startPhase)}`} />
          <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `osc${index}.pulseWidth` }} spec={PARAM_SPECS.pulseWidth} value={osc.pulseWidth} color={color} disabled={osc.waveform !== 'pulse'} onChange={(v) => onChange({ pulseWidth: v }, 'pw')} />
        </div>
        <div className="flex flex-col gap-0.5" title="Phase at note-on: Reset = fixed start phase, Random = random phase per note, Free = keep running">
          <span className="text-[9px] uppercase tracking-wide text-muted">Phase</span>
          <Segmented value={osc.phaseMode} options={PHASE_MODES} onChange={(m) => onChange({ phaseMode: m }, 'pmode')} render={(m) => (m === 'reset' ? 'Rst' : m === 'random' ? 'Rnd' : 'Free')} />
        </div>
      </div>
      {am && <div className="ml-auto max-w-[120px] text-right text-[9px] leading-tight text-accent-hi">Modulating osc 1 + 2 amplitude (not heard directly)</div>}
    </div>
  );
}

function EnvBlock({ trackId, prefix, env, color, onChange }: { trackId: string; prefix: 'ampEnv' | 'filterEnv'; env: EnvelopeParams; color: string; onChange: (p: Partial<EnvelopeParams>, key: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <EnvelopeGraph env={env} color={color} width={168} height={44} />
      <div className="flex gap-1.5">
        <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `${prefix}.attack` }} spec={PARAM_SPECS.attack} value={env.attack} color={color} onChange={(v) => onChange({ attack: v }, 'a')} />
        <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `${prefix}.decay` }} spec={PARAM_SPECS.decay} value={env.decay} color={color} onChange={(v) => onChange({ decay: v }, 'd')} />
        <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `${prefix}.sustain` }} spec={PARAM_SPECS.sustain} value={env.sustain} color={color} onChange={(v) => onChange({ sustain: v }, 's')} />
        <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `${prefix}.release` }} spec={PARAM_SPECS.release} value={env.release} color={color} onChange={(v) => onChange({ release: v }, 'r')} />
      </div>
    </div>
  );
}
