import { useEffect, useRef, useState } from 'react';
import { Drum, FolderOpen, RotateCcw, Send, SlidersHorizontal, Sparkles, Split, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { DRUM_CHOKE_GROUPS, DRUM_PADS, DRUM_SPECS, DRUM_VOICES, FACTORY_KITS, defaultKit, padNote } from '../../drums/kit';
import { midiNoteName } from '../../core/time';
import type { DrumKit, DrumPad, DrumVoiceType, InstrumentConfig } from '../../project/types';
import { getProject, setInstrumentConfig, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { AutoKnob } from '../common/AutoKnob';
import { useLiveKeys } from '../liveKeys';
import { EffectDevice } from '../effects/EffectDevice';
import { SEND_SPEC } from '../mixer/Mixer';
import { addEffect, setPadSend } from '../../state/effectActions';
import { EFFECT_LABELS } from '../../audio/effects/specs';
import { SEND_IDS, padChainId, sendLabel } from '../../project/types';
import { openTrackDevices } from '../../state/uiStore';
import { splitPadToTrack } from '../actions';


type DrumConfig = Extract<InstrumentConfig, { type: 'drumrack' }>;

/** Physical keys → pad index (bottom row Z X C V = pads 1-4, like hardware). */
export const KEY_PADS: Record<string, number> = {
  KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3,
  KeyA: 4, KeyS: 5, KeyD: 6, KeyF: 7,
  KeyQ: 8, KeyW: 9, KeyE: 10, KeyR: 11,
  Digit1: 12, Digit2: 13, Digit3: 14, Digit4: 15,
};
const KEY_LABEL = ['Z', 'X', 'C', 'V', 'A', 'S', 'D', 'F', 'Q', 'W', 'E', 'R', '1', '2', '3', '4'];
const ACCENT = '#fb923c';

function liveConfig(trackId: string): DrumConfig | null {
  const inst = getProject().tracks.find((t) => t.id === trackId)?.instrument;
  return inst?.type === 'drumrack' ? inst : null;
}

function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff)$/i.test(f.name);
}

export function DrumRackWindow({ trackId }: { trackId: string }) {
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const assets = useProjectStore((s) => s.project.assets);
  const sendBuses = useProjectStore((s) => s.project.sends);
  const setUi = useUiStore((s) => s.set);
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - 900) / 2), y: Math.max(56, window.innerHeight - 790) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const padEls = useRef<(HTMLButtonElement | null)[]>([]);
  const fileOne = useRef<HTMLInputElement>(null);
  const fileMany = useRef<HTMLInputElement>(null);
  const [dropPad, setDropPad] = useState<number | null>(null);

  const close = () => setUi({ synthTrackId: null });
  useEffect(() => {
    if (!track || track.instrument?.type !== 'drumrack') setUi({ synthTrackId: null });
  }, [track, setUi]);
  useEffect(() => root.current?.focus(), [trackId]);

  // flash pads when they're hit (live or by the sequencer), read from the instrument each frame
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const rack = engine.drumRack(trackId);
      const now = engine.ctx?.currentTime ?? 0;
      for (let i = 0; i < DRUM_PADS; i++) {
        const el = padEls.current[i];
        if (!el) continue;
        const t = rack?.lastHit[i] ?? -1;
        const age = now - t;
        const on = t >= 0 && age >= 0 && age < 0.12;
        el.style.boxShadow = on ? `0 0 0 2px ${ACCENT}, 0 0 14px ${ACCENT}88` : '';
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [trackId]);

  // the open rack owns the computer keyboard, wherever the focus is (see liveKeys)
  useLiveKeys({
    keyDown: (e) => {
      if (e.code === 'Escape') {
        close();
        return true;
      }
      const i = KEY_PADS[e.code];
      if (i === undefined) return false;
      if (!e.repeat) {
        void engine.resume();
        engine.previewNoteOn(trackId, padNote(i), 0.85);
        setSel(i);
      }
      return true;
    },
    keyUp: (e) => KEY_PADS[e.code] !== undefined,
    release: () => {},
  });

  if (!track || track.instrument?.type !== 'drumrack') return null;
  const cfg = track.instrument;
  const pad = cfg.kit.pads[sel] as DrumPad;

  const commitKit = (kit: DrumKit, label: string, coalesce?: string, presetName?: string) => {
    const c = liveConfig(trackId);
    if (!c) return;
    setInstrumentConfig(trackId, { ...c, kit, presetName: presetName ?? (c.presetName.endsWith('*') ? c.presetName : `${c.presetName}*`) }, label, coalesce ? { coalesce } : {});
  };
  const setPad = (i: number, part: Partial<DrumPad>, key: string) => {
    const c = liveConfig(trackId);
    if (!c) return;
    commitKit({ pads: c.kit.pads.map((p, j) => (j === i ? { ...p, ...part } : p)) }, 'Edit pad', `pad-${trackId}-${i}-${key}`);
  };
  const setSynth = (part: Partial<Extract<DrumPad['source'], { kind: 'synth' }>>, key: string) => {
    if (pad.source.kind !== 'synth') return;
    setPad(sel, { source: { ...pad.source, ...part } }, key);
  };
  const hit = (i: number, velocity: number) => {
    void engine.resume();
    engine.previewNoteOn(trackId, padNote(i), velocity);
  };

  /** Decode files and assign them to pads starting at `start` (one file per pad). */
  const loadSamples = async (files: File[], start: number) => {
    const audio = files.filter(isAudioFile).slice(0, DRUM_PADS - start);
    if (!audio.length) return uiToast('error', 'Drop audio files (wav, mp3, ogg, flac, aiff …) onto a pad.');
    let i = start;
    for (const f of audio) {
      try {
        const asset = await engine.importAudioFile(f);
        const c = liveConfig(trackId);
        if (!c) return;
        const name = asset.ref.name.slice(0, 24);
        const pads = c.kit.pads.map((p, j) => (j === i ? { ...p, name, source: { kind: 'sample' as const, assetId: asset.ref.id }, tune: 0, decay: DRUM_SPECS.decay.max } : p));
        useProjectStore.getState().commit(`Load sample into pad ${i + 1}`, (p) => ({
          ...p,
          assets: { ...p.assets, [asset.ref.id]: asset.ref },
          tracks: p.tracks.map((t) => (t.id === trackId && t.instrument?.type === 'drumrack' ? { ...t, instrument: { ...t.instrument, kit: { pads }, presetName: `${t.instrument.presetName.replace(/\*$/, '')}*` } } : t)),
        }));
        i++;
      } catch (e) {
        uiToast('error', e instanceof Error ? e.message : `Could not load ${f.name}`);
      }
    }
    setSel(Math.min(DRUM_PADS - 1, i - 1));
    if (audio.length > 1) uiToast('info', `Loaded ${i - start} samples into pads ${start + 1}–${i}.`);
  };


  // rows top → bottom: pads 13-16, 9-12, 5-8, 1-4
  const rows = [12, 8, 4, 0].map((r) => [r, r + 1, r + 2, r + 3]);

  return (
    <div
      ref={root}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, width: 900 }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70 outline-none"
    >
      <div
        className="flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-panel-3 to-panel px-3"
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
        <Drum size={15} style={{ color: ACCENT }} />
        <span className="text-[14px] font-bold tracking-[0.18em] text-fg">DRUM RACK</span>
        <span className="text-[10px] uppercase tracking-wider text-muted">· {track.name}</span>
        <select
          className="ml-4 h-6 w-40"
          title="Kit"
          value={FACTORY_KITS.some((k) => k.name === cfg.presetName) ? cfg.presetName : ''}
          onChange={(e) => {
            const k = FACTORY_KITS.find((x) => x.name === e.target.value);
            if (k) commitKit(structuredClone(k.kit), 'Load kit', undefined, k.name);
          }}
        >
          {!FACTORY_KITS.some((k) => k.name === cfg.presetName) && <option value="">{cfg.presetName}</option>}
          {FACTORY_KITS.map((k) => (
            <option key={k.name} value={k.name}>
              {k.name}
            </option>
          ))}
        </select>
        <button type="button" title="Reset to the default kit" onClick={() => commitKit(defaultKit(), 'Reset kit', undefined, FACTORY_KITS[0]?.name)} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2">
          <RotateCcw size={12} /> Init
        </button>
        <button
          type="button"
          title="Load several samples into consecutive pads, starting at the selected pad"
          onClick={() => fileMany.current?.click()}
          className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2"
        >
          <FolderOpen size={12} /> Load samples…
        </button>
        <input
          ref={fileMany}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void loadSamples(files, sel);
          }}
        />
        <span className="ml-auto text-[9px] text-dim">Keys Z–V / A–F / Q–R / 1–4 · drop audio on a pad</span>
        <button type="button" title="Close (Esc)" onClick={close} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
          <X size={14} />
        </button>
      </div>

      <div className="flex gap-3 p-3">
        {/* pad grid */}
        <div className="grid grid-cols-4 gap-1.5">
          {rows.flat().map((i) => {
            const p = cfg.kit.pads[i] as DrumPad;
            const isSample = p.source.kind === 'sample';
            const missing = isSample && p.source.kind === 'sample' && !assets[p.source.assetId];
            return (
              <button
                key={i}
                ref={(el) => {
                  padEls.current[i] = el;
                }}
                type="button"
                title={`${p.name} — ${midiNoteName(padNote(i))} · key ${KEY_LABEL[i]} · click to play, drop audio to replace`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const vel = 0.3 + 0.7 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
                  setSel(i);
                  hit(i, vel);
                }}
                onDragOver={(e) => {
                  if ([...e.dataTransfer.types].includes('Files')) {
                    e.preventDefault();
                    setDropPad(i);
                  }
                }}
                onDragLeave={() => setDropPad((d) => (d === i ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropPad(null);
                  void loadSamples([...e.dataTransfer.files], i);
                }}
                className={`relative flex h-[68px] w-[92px] flex-col justify-between rounded-md border p-1.5 text-left transition-colors ${
                  sel === i ? 'border-[#fb923c] bg-panel-3' : 'border-line bg-panel-2 hover:bg-panel-3'
                } ${dropPad === i ? 'ring-2 ring-accent' : ''}`}
              >
                <span className="truncate text-[11px] font-semibold text-fg">{p.name}</span>
                <span className="flex items-center justify-between text-[9px] text-muted">
                  <span className={missing ? 'text-bad' : isSample ? 'text-accent-hi' : 'text-dim'}>{missing ? 'missing' : isSample ? 'sample' : 'synth'}</span>
                  <span className="font-mono">
                    {KEY_LABEL[i]} · {midiNoteName(padNote(i))}
                  </span>
                </span>
                {p.choke > 0 && <span className="absolute right-1 top-1 rounded bg-base px-1 text-[8px] text-muted">C{p.choke}</span>}
                <span className="absolute bottom-[18px] right-1 flex gap-0.5">
                  {p.eq && (
                    <span className={`rounded px-1 text-[8px] font-semibold ${p.eq.enabled ? 'bg-[#f472b6] text-black' : 'bg-base text-dim'}`} title="This pad has its own EQ">
                      EQ
                    </span>
                  )}
                  {(p.sends?.[0] ?? 0) > 0 && <span className="h-1.5 w-1.5 self-center rounded-full bg-[#38bdf8]" title="Sends to A" />}
                  {(p.sends?.[1] ?? 0) > 0 && <span className="h-1.5 w-1.5 self-center rounded-full bg-[#fb923c]" title="Sends to B" />}
                </span>
              </button>
            );
          })}
        </div>

        {/* selected pad editor */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-line bg-panel-2 p-2">
          <div className="flex items-center gap-2">
            <span className="rounded px-1.5 text-[10px] font-bold text-black" style={{ background: ACCENT }}>
              PAD {sel + 1}
            </span>
            <input
              value={pad.name}
              onChange={(e) => setPad(sel, { name: e.target.value.slice(0, 24) }, 'name')}
              className="h-6 w-40 rounded border border-line bg-base px-1.5 text-[12px] text-fg outline-none"
              title="Pad name (also shown in the piano roll)"
            />
            <span className="font-mono text-[10px] text-dim">{midiNoteName(padNote(sel))}</span>
            <button type="button" onClick={() => hit(sel, 0.85)} className="ml-auto h-6 rounded px-2 text-[11px] font-semibold text-black" style={{ background: ACCENT }}>
              Play
            </button>
          </div>

          <div className="flex items-center gap-2 text-[10px]">
            <span className="w-12 text-muted">Sound</span>
            <div className="inline-flex overflow-hidden rounded border border-line">
              <button
                type="button"
                onClick={() => pad.source.kind !== 'synth' && setPad(sel, { name: 'Kick', source: { kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.5, length: 0.4 } }, 'src')}
                className={`px-2 py-0.5 uppercase tracking-wide ${pad.source.kind === 'synth' ? 'text-black' : 'bg-panel-3 text-muted'}`}
                style={pad.source.kind === 'synth' ? { background: ACCENT } : undefined}
              >
                Built-in
              </button>
              <button
                type="button"
                onClick={() => fileOne.current?.click()}
                className={`px-2 py-0.5 uppercase tracking-wide ${pad.source.kind === 'sample' ? 'text-black' : 'bg-panel-3 text-muted'}`}
                style={pad.source.kind === 'sample' ? { background: ACCENT } : undefined}
                title="Replace this pad with your own sample"
              >
                Sample…
              </button>
            </div>
            <input
              ref={fileOne}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff"
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void loadSamples(files, sel);
              }}
            />
            {pad.source.kind === 'synth' ? (
              <select
                value={pad.source.voice}
                onChange={(e) => {
                  const voice = e.target.value as DrumVoiceType;
                  const oldLabel = DRUM_VOICES.find((v) => pad.source.kind === 'synth' && v.type === pad.source.voice)?.label;
                  const newLabel = DRUM_VOICES.find((v) => v.type === voice)?.label ?? pad.name;
                  if (pad.source.kind === 'synth') setPad(sel, { source: { ...pad.source, voice }, ...(pad.name === oldLabel ? { name: newLabel } : {}) }, 'voice');
                }}
                className="h-5"
                title="Built-in drum voice"
              >
                {DRUM_VOICES.map((v) => (
                  <option key={v.type} value={v.type}>
                    {v.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className={`truncate ${assets[pad.source.assetId] ? 'text-accent-hi' : 'text-bad'}`} title="Sample asset">
                {assets[pad.source.assetId]?.name ?? 'missing sample'} {assets[pad.source.assetId] ? `· ${assets[pad.source.assetId]?.durationSec.toFixed(2)} s` : ''}
              </span>
            )}
          </div>

          <div className="flex items-end gap-3">
            {pad.source.kind === 'synth' && (
              <div className="flex gap-1.5 rounded border border-line/70 p-1.5">
                <Knob spec={DRUM_SPECS.tone} value={pad.source.tone} color={ACCENT} onChange={(v) => setSynth({ tone: v }, 'tone')} />
                <Knob spec={DRUM_SPECS.snap} value={pad.source.snap} color={ACCENT} onChange={(v) => setSynth({ snap: v }, 'snap')} />
                <Knob spec={DRUM_SPECS.length} value={pad.source.length} color={ACCENT} onChange={(v) => setSynth({ length: v }, 'len')} />
              </div>
            )}
            <div className="flex gap-1.5 rounded border border-line/70 p-1.5">
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `p${sel}.gain` }} spec={DRUM_SPECS.gain} value={pad.gain} color={ACCENT} onChange={(v) => setPad(sel, { gain: v }, 'gain')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `p${sel}.pan` }} spec={DRUM_SPECS.pan} value={pad.pan} color={ACCENT} onChange={(v) => setPad(sel, { pan: Math.abs(v) < 0.02 ? 0 : v }, 'pan')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `p${sel}.tune` }} spec={DRUM_SPECS.tune} value={pad.tune} color={ACCENT} onChange={(v) => setPad(sel, { tune: Math.round(v * 10) / 10 }, 'tune')} />
              <AutoKnob trackId={trackId} target={{ kind: 'inst', param: `p${sel}.decay` }} spec={DRUM_SPECS.decay} value={pad.decay} color={ACCENT} onChange={(v) => setPad(sel, { decay: v }, 'decay')} />
            </div>
            <div className="flex flex-col gap-0.5" title="Choke group: pads in the same group cut each other off (e.g. open hat stopped by closed hat)">
              <span className="text-[9px] uppercase tracking-wide text-muted">Choke</span>
              <select value={pad.choke} onChange={(e) => setPad(sel, { choke: Number(e.target.value) }, 'choke')} className="h-5">
                <option value={0}>None</option>
                {Array.from({ length: DRUM_CHOKE_GROUPS }, (_, g) => (
                  <option key={g + 1} value={g + 1}>
                    Group {g + 1}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {pad.source.kind === 'sample' && (
            <button
              type="button"
              onClick={() => setPad(sel, { name: 'Kick', source: { kind: 'synth', voice: 'kick', tone: 0.5, snap: 0.5, length: 0.4 } }, 'builtin')}
              className="flex w-max items-center gap-1 text-[10px] text-muted hover:text-fg"
              title="Go back to a built-in synthesized sound (the sample stays in the project)"
            >
              <Sparkles size={11} /> Use built-in sound instead
            </button>
          )}
          <div className="mt-auto text-[10px] leading-snug text-dim">
            Each pad plays MIDI note {midiNoteName(padNote(0))}–{midiNoteName(padNote(DRUM_PADS - 1))} in the piano roll. Drop one audio file on a pad to replace it, or several to fill pads from there.
          </div>
        </div>
      </div>
      {/* the pad's own mixing: detailed EQ, sends, or a track of its own */}
      <div className="flex items-start gap-2 overflow-x-auto border-t border-line bg-panel-2/40 px-2 py-2">
        {pad.eq ? (
          <EffectDevice trackId={padChainId(trackId, sel)} slot={pad.eq} index={0} count={1} />
        ) : (
          <button
            type="button"
            onClick={() => addEffect(padChainId(trackId, sel), 'peq')}
            className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-2 text-[11px] text-muted hover:border-accent hover:text-fg"
            title="Give this pad its own full Spectra EQ (8 bands, presets like Kick Punch, live spectrum)"
          >
            <SlidersHorizontal size={18} />
            + Spectra EQ
            <span className="text-[9px] text-dim">for {pad.name} only</span>
          </button>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-center gap-1 rounded-md border border-line bg-panel p-2" title="Send this pad (after its EQ) to a shared send channel — e.g. only the hats into a chorus">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
              <Send size={11} /> Pad sends
            </span>
            <div className="flex gap-2">
              {[0, 1].map((k) => {
                const bus = sendBuses[k];
                return (
                  <Knob
                    key={k}
                    spec={SEND_SPEC}
                    value={pad.sends?.[k] ?? 0}
                    size={30}
                    label={k === 0 ? 'Send A' : 'Send B'}
                    color={k === 0 ? '#38bdf8' : '#fb923c'}
                    title={`Send ${pad.name} to ${bus ? sendLabel(bus, (t) => EFFECT_LABELS[t]) : 'send ' + (k ? 'B' : 'A')}: ${SEND_SPEC.format(pad.sends?.[k] ?? 0)}`}
                    onChange={(v) => setPadSend(trackId, sel, k, v < 0.01 ? 0 : v, `padsend-${trackId}-${sel}-${k}`)}
                  />
                );
              })}
            </div>
            <button type="button" onClick={() => openTrackDevices(SEND_IDS[0])} className="text-[9px] text-dim hover:text-fg">
              edit send channels…
            </button>
          </div>
          <button
            type="button"
            onClick={() => splitPadToTrack(trackId, sel)}
            className="flex h-7 items-center justify-center gap-1 rounded bg-panel-3 px-2 text-[11px] text-fg hover:bg-line-2"
            title={`Move ${pad.name} and its notes onto a track of its own (its EQ becomes a Spectra EQ insert there, so you get the full effect chain)`}
          >
            <Split size={12} /> Split to own track
          </button>
        </div>
      </div>
    </div>
  );
}
