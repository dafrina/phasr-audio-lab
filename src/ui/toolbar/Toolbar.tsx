import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Keyboard,
  SlidersVertical,
  Spline,
  FileAudio,
  Magnet,
  Pause,
  Play,
  Redo2,
  Repeat,
  Square,
  Timer,
  Undo2,
} from 'lucide-react';
import { engine } from '../../audio/engine';
import { PPQ, SNAP_VALUES, formatBBT, formatSeconds, ticksToSeconds, type SnapValue } from '../../core/time';
import { RecordControls } from './RecordControls';
import { getProject, updateProjectFields, useProjectStore } from '../../state/projectStore';
import { useTransportStore } from '../../state/transportStore';
import { useUiStore } from '../../state/uiStore';
import { IconButton } from '../common/controls';
import { Meter } from '../common/Meter';
import { importAudioFiles, importMidiFiles, stopTransport, togglePlay } from '../actions';
import { isMidiFileName } from '../../midi/smf';
import { ProjectControls, openExportDialog } from '../project/ProjectUI';
import { midiInput, type MidiStatus } from '../../audio/webmidi';
import { toggleMixer, uiToast } from '../../state/uiStore';

function AutomationModeButton() {
  const on = useUiStore((s) => s.automationMode);
  const set = useUiStore((s) => s.set);
  return (
    <IconButton
      title={on ? 'Automation mode ON (A): click on a track with a shown lane to add/move points; right-click or double-click deletes' : 'Automation mode (A): draw automation on tracks (choose a lane in the track header, or right-click a knob → Automate)'}
      active={on}
      activeClass="bg-[#f472b6] text-black"
      onClick={() => set({ automationMode: !on })}
    >
      <Spline size={14} />
    </IconButton>
  );
}

function MixerButton() {
  const open = useUiStore((s) => s.bottomPanel === 'mixer');
  return (
    <IconButton title="Mixer (F9)" active={open} onClick={toggleMixer}>
      <SlidersVertical size={14} />
    </IconButton>
  );
}

function MidiButton() {
  const [st, setSt] = useState<MidiStatus>(midiInput.getStatus());
  useEffect(() => midiInput.subscribe((s) => {
    setSt(s);
    if (s.error) uiToast('error', s.error);
  }), []);
  const title = !st.supported
    ? 'Web MIDI is not supported in this browser'
    : st.enabled
      ? `MIDI input on — ${st.inputs.length ? st.inputs.join(', ') : 'no devices connected'}. Notes go to the open TriOsc, else the selected instrument track. Click to turn off.`
      : 'Enable MIDI keyboard input (the browser will ask for permission)';
  return (
    <IconButton
      title={title}
      disabled={!st.supported}
      active={st.enabled}
      onClick={() => (st.enabled ? midiInput.disable() : void midiInput.enable())}
    >
      <Keyboard size={14} />
      {st.enabled && <span className="font-mono text-[10px]">{st.inputs.length}</span>}
    </IconButton>
  );
}

function PositionDisplay() {
  const bbt = useRef<HTMLDivElement>(null);
  const secs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const p = useProjectStore.getState().project;
      const tick = engine.transport?.getTick() ?? 0;
      const a = formatBBT(tick, p.timeSignature);
      if (a !== last && bbt.current && secs.current) {
        last = a;
        bbt.current.textContent = a;
        secs.current.textContent = formatSeconds(ticksToSeconds(tick, p.bpm));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex h-8 min-w-[132px] flex-col justify-center rounded border border-line bg-base px-2.5 font-mono leading-tight" title="Position: bar.beat.tick (960 PPQ) / minutes:seconds">
      <div ref={bbt} className="text-[14px] text-accent-hi">1.1.000</div>
      <div ref={secs} className="text-[9px] text-muted">0:00.000</div>
    </div>
  );
}

function BpmInput() {
  const bpm = useProjectStore((s) => s.project.bpm);
  const [text, setText] = useState(String(bpm));
  const drag = useRef<{ y: number; v: number } | null>(null);
  useEffect(() => setText(String(bpm)), [bpm]);
  const commit = (v: number, coalesce?: string) => {
    if (!Number.isFinite(v)) return setText(String(bpm));
    const clamped = Math.round(Math.min(400, Math.max(20, v)) * 100) / 100;
    updateProjectFields('Change tempo', { bpm: clamped }, coalesce);
  };
  return (
    <div className="flex items-center gap-1" title="Tempo (BPM). Type a value, or drag vertically.">
      <span
        className="cursor-ns-resize text-[9px] font-semibold uppercase tracking-wider text-muted"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: bpm };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          commit(Math.round(drag.current.v + (drag.current.y - e.clientY) * 0.25), 'bpm-drag');
        }}
        onPointerUp={() => (drag.current = null)}
      >
        BPM
      </span>
      <input
        type="number"
        value={text}
        min={20}
        max={400}
        step={1}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(parseFloat(text))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(String(bpm));
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-7 w-14 rounded border border-line bg-base px-1.5 text-center font-mono text-[12px] text-fg outline-none"
      />
    </div>
  );
}

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const canUndo = useProjectStore((s) => s.history.past.length > 0);
  const canRedo = useProjectStore((s) => s.history.future.length > 0);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const transport = useTransportStore((s) => s.state);
  const engineStatus = useTransportStore((s) => s.engineStatus);
  const running = useTransportStore((s) => s.contextRunning);
  const snap = useUiStore((s) => s.snap);
  const setUi = useUiStore((s) => s.set);
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);
  const playing = transport === 'playing';
  const ts = project.timeSignature;

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <img src={`${import.meta.env.BASE_URL}phasr-logo.png`} alt="PHASR Audio Lab" className="h-[22px] select-none" draggable={false} />
      <div className="h-6 w-px bg-line" />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== project.name && updateProjectFields('Rename project', { name: name.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="h-7 w-44 rounded border border-transparent bg-transparent px-1.5 text-[13px] font-medium text-fg outline-none hover:border-line focus:border-line focus:bg-base"
        title="Project name"
      />
      <ProjectControls />

      <div className="flex items-center gap-1">
        <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={14} />
        </IconButton>
        <IconButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={14} />
        </IconButton>
      </div>

      <div className="mx-auto flex items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton title="Stop (returns to start; press again for bar 1)" onClick={stopTransport}>
            <Square size={13} fill="currentColor" />
          </IconButton>
          <IconButton title="Play / Stop (Space)" active={playing} activeClass="bg-ok/20 text-ok" onClick={togglePlay} disabled={engineStatus !== 'ready'}>
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </IconButton>
          <RecordControls />
          <IconButton
            title="Loop playback over the loop region (drag in the ruler to set it)"
            active={project.loop.enabled}
            onClick={() => updateProjectFields('Toggle loop', { loop: { ...project.loop, enabled: !project.loop.enabled } })}
          >
            <Repeat size={14} />
          </IconButton>
          <IconButton
            title="Metronome"
            active={project.metronome}
            onClick={() => updateProjectFields('Toggle metronome', { metronome: !project.metronome })}
          >
            <Timer size={14} />
          </IconButton>
        </div>
        <PositionDisplay />
        <BpmInput />
        <div className="flex items-center gap-1" title="Time signature">
          <select
            value={ts.numerator}
            onChange={(e) => updateProjectFields('Time signature', { timeSignature: { ...ts, numerator: Number(e.target.value) } })}
          >
            {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="text-muted">/</span>
          <select
            value={ts.denominator}
            onChange={(e) => updateProjectFields('Time signature', { timeSignature: { ...ts, denominator: Number(e.target.value) } })}
          >
            {[2, 4, 8, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1" title="Snap grid for editing (hold Shift while dragging to bypass)">
          <Magnet size={13} className="text-muted" />
          <select value={snap} onChange={(e) => setUi({ snap: e.target.value as SnapValue })}>
            {SNAP_VALUES.map((s) => (
              <option key={s} value={s}>
                {s === 'off' ? 'Off' : s === 'bar' ? 'Bar' : s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.mid,.midi"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            const tick = Math.round((engine.transport?.getTick() ?? 0) / PPQ) * PPQ;
            const midi = files.filter((f) => isMidiFileName(f.name));
            const audio = files.filter((f) => !midi.includes(f));
            // MIDI goes onto the selected instrument track, else onto new tracks
            const sel = useUiStore.getState().selectedTrackId;
            const inst = getProject().tracks.find((t) => t.id === sel && t.kind === 'instrument');
            if (midi.length) void importMidiFiles(midi, { trackId: inst?.id, tick });
            if (audio.length) void importAudioFiles(audio, { tick });
          }}
        />
        <IconButton title="Import audio or MIDI files (or drag & drop onto the timeline; MIDI also into the piano roll)" onClick={() => fileInput.current?.click()}>
          <FileAudio size={14} /> <span className="text-[11px]">Import</span>
        </IconButton>
        <div className="mx-1 h-6 w-px bg-line" />
        <IconButton title="Keyboard shortcuts (?)" onClick={() => setUi({ helpOpen: true })}>
          <span className="text-[12px] font-bold">?</span>
        </IconButton>
        <AutomationModeButton />
        <MixerButton />
        <MidiButton />
        <div className="mx-1 h-6 w-px bg-line" />
        <IconButton title="Export audio (WAV / MP3)…" onClick={openExportDialog}>
          <Download size={14} />
        </IconButton>
        <div className="ml-1 flex items-center gap-1.5" title="Master output level">
          <Meter source="master" width={9} height={30} showPeak />
        </div>
        <div
          className={`ml-1 h-2 w-2 rounded-full ${engineStatus === 'ready' && running ? 'bg-ok' : engineStatus === 'error' ? 'bg-bad' : 'bg-warn'}`}
          title={
            engineStatus === 'error'
              ? 'Audio engine failed'
              : engineStatus !== 'ready'
                ? 'Audio engine loading'
                : running
                  ? 'Audio running'
                  : 'Audio suspended — click anywhere to enable sound'
          }
        />
      </div>
    </div>
  );
}
