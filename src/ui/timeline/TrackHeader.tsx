import { useEffect, useRef, useState } from 'react';
import { AudioLines, Music, SlidersHorizontal, Trash2 } from 'lucide-react';
import { INSTRUMENTS } from '../../instruments/definitions';
import { INSTRUMENT_UI } from '../instruments';
import { PARAM_SPECS, type NumericParamSpec } from '../../synth/params';
import type { Track } from '../../project/types';
import { removeTrack, updateTrack } from '../../state/projectStore';
import { openTrackDevices, useUiStore } from '../../state/uiStore';
import { AutoKnob, useAutomatedValue } from '../common/AutoKnob';
import { automate, endAutomationGesture, showLane, writeAutomation } from '../../state/automationActions';
import { duckFrom } from '../../state/modulationActions';
import { useProjectStore } from '../../state/projectStore';
import { targetInfo } from '../../project/automation';
import type { AutomationTarget } from '../../project/types';
import { Meter } from '../common/Meter';
import { ToggleChip } from '../common/controls';
import { TRACK_H } from './layout';
import { recorder } from '../../audio/recorder';

const PAN_SPEC: NumericParamSpec = PARAM_SPECS.pan;
const VOL_TARGET: AutomationTarget = { kind: 'track', param: 'volumeDb' };
const PAN_TARGET: AutomationTarget = { kind: 'track', param: 'pan' };

export function formatDb(db: number): string {
  return db <= -59.9 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

export function TrackHeader({ track, selected }: { track: Track; selected: boolean }) {
  const setUi = useUiStore((s) => s.set);
  const synthOpen = useUiStore((s) => s.synthTrackId === track.id);
  const fxOpen = useUiStore((s) => s.bottomPanel === 'track' && (s.fxTrackId ?? s.selectedTrackId) === track.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const colorInput = useRef<HTMLInputElement>(null);
  const dragKey = useRef('');
  const instDef = track.instrument ? INSTRUMENTS[track.instrument.type] : null;
  const InstIcon = track.instrument ? INSTRUMENT_UI[track.instrument.type].icon : null;
  const vol = useAutomatedValue(track.id, VOL_TARGET, track.volumeDb);
  const shownLane = useUiStore((s) => s.shownLanes[track.id] ?? null);
  const allTracks = useProjectStore((s) => s.project.tracks);
  const otherTracks = allTracks.filter((t) => t.id !== track.id);
  useEffect(() => setName(track.name), [track.name]);

  const commitName = () => {
    setEditing(false);
    const n = name.trim();
    if (n && n !== track.name) updateTrack(track.id, { name: n.slice(0, 32) }, 'Rename track');
    else setName(track.name);
  };

  return (
    <div
      style={{ height: TRACK_H }}
      onPointerDown={() => setUi({ selectedTrackId: track.id })}
      className={`relative flex shrink-0 border-b border-line ${selected ? 'bg-panel-3' : 'bg-panel-2'}`}
    >
      <button
        type="button"
        title="Track color"
        className="w-1.5 shrink-0 cursor-pointer"
        style={{ background: track.color }}
        onClick={() => colorInput.current?.click()}
      />
      <input
        ref={colorInput}
        type="color"
        value={track.color}
        className="invisible absolute h-0 w-0"
        onChange={(e) => updateTrack(track.id, { color: e.target.value }, 'Track color', { coalesce: `color-${track.id}` })}
      />
      <div className="flex min-w-0 flex-1 flex-col justify-between px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span title={track.kind === 'audio' ? 'Audio track' : `Instrument track (${instDef?.label ?? 'instrument'})`} className="text-muted">
            {track.kind === 'audio' ? <AudioLines size={13} /> : InstIcon ? <InstIcon size={13} /> : <Music size={13} />}
          </span>
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setName(track.name);
                  setEditing(false);
                }
              }}
              className="h-5 min-w-0 flex-1 rounded border border-line bg-base px-1 text-[12px] text-fg outline-none"
            />
          ) : (
            <div
              className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg"
              title={`${track.name} — double-click to rename`}
              onDoubleClick={() => setEditing(true)}
            >
              {track.name}
            </div>
          )}
          <ToggleChip
            on={track.mute}
            label="M"
            title="Mute"
            onClass="bg-warn text-black"
            onClick={() => updateTrack(track.id, { mute: !track.mute }, 'Mute')}
          />
          <ToggleChip
            on={track.solo}
            label="S"
            title="Solo"
            onClass="bg-ok text-black"
            onClick={() => updateTrack(track.id, { solo: !track.solo }, 'Solo')}
          />
          {track.kind === 'audio' && (
            <ToggleChip
              on={track.monitor}
              label="I"
              title="Input monitoring: hear the armed input through this track's effects (use headphones to avoid feedback)"
              onClass="bg-accent text-white"
              onClick={() => recorder.setMonitor(track.id, !track.monitor)}
            />
          )}
          <ToggleChip
            on={track.armed}
            label="R"
            title={track.kind === 'audio' ? (track.armed ? 'Disarm recording' : 'Arm for recording (opens the audio input)') : 'Recording is for audio tracks; play the instrument live or draw notes in the piano roll'}
            onClass="bg-bad text-white"
            disabled={track.kind !== 'audio'}
            onClick={() => void recorder.toggleArm(track.id)}
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            className="fader min-w-0 flex-1"
            min={-60}
            max={6}
            step={0.1}
            value={vol.value}
            title={`Volume ${formatDb(vol.value)} dB${vol.automated ? ' — automated (moving writes automation)' : ' — double-click to reset'}`}
            onPointerDown={() => (dragKey.current = `vol-${track.id}-${Date.now()}`)}
            onPointerUp={() => endAutomationGesture(dragKey.current)}
            onDoubleClick={() => !vol.automated && updateTrack(track.id, { volumeDb: 0 }, 'Volume')}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (vol.automated) writeAutomation(track.id, VOL_TARGET, v, dragKey.current || `vol-${track.id}`);
              else updateTrack(track.id, { volumeDb: v }, 'Volume', { coalesce: dragKey.current || `vol-${track.id}` });
            }}
          />
          <span className={`w-9 text-right font-mono text-[10px] ${vol.automated ? 'text-[#f472b6]' : 'text-muted'}`}>{formatDb(vol.value)}</span>
        </div>
        <div className="flex items-center gap-1">
          {track.kind === 'instrument' ? (
            <button
              type="button"
              title={`Open ${instDef?.label ?? 'instrument'}`}
              onClick={() => setUi({ synthTrackId: synthOpen ? null : track.id, selectedTrackId: track.id })}
              className={`flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                synthOpen ? 'bg-accent text-white' : 'bg-panel text-muted hover:text-fg'
              }`}
            >
              {InstIcon && <InstIcon size={11} className="shrink-0" />} <span className="max-w-[64px] truncate">{track.instrument?.presetName ?? instDef?.label}</span>
            </button>
          ) : (
            <span className="text-[10px] text-dim">Audio</span>
          )}
          <button
            type="button"
            title={`Insert effects (${track.effects.length}/4) — open the track device panel`}
            onClick={() => openTrackDevices(track.id)}
            className={`flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold uppercase ${
              fxOpen ? 'bg-accent text-white' : track.effects.length ? 'bg-panel text-fg' : 'bg-panel text-muted hover:text-fg'
            }`}
          >
            <SlidersHorizontal size={11} /> FX{track.effects.length ? ` ${track.effects.length}` : ''}
          </button>
          <select
            value={shownLane ?? ''}
            title="Automation lane shown on this track. Right-click any effect knob to automate it; press A for Automation mode to draw points."
            onChange={(e) => {
              const v = e.target.value;
              if (v === '+volumeDb' || v === '+pan') automate(track.id, { kind: 'track', param: v.slice(1) as 'volumeDb' | 'pan' });
              else if (v.startsWith('duck:')) duckFrom(track.id, v.slice(5));
              else showLane(track.id, v || null);
            }}
            className={`!h-5 max-w-[80px] !pl-1 !pr-4 !text-[10px] ${shownLane ? '!text-[#f472b6]' : '!text-muted'}`}
          >
            <option value="">Auto…</option>
            {track.automation.map((l) => (
              <option key={l.id} value={l.id}>
                {targetInfo(track, l.target)?.fullLabel ?? 'Lane'}
                {l.enabled ? '' : ' (off)'}
              </option>
            ))}
            {!track.automation.some((l) => l.target.kind === 'track' && l.target.param === 'volumeDb') && <option value="+volumeDb">+ Volume</option>}
            {!track.automation.some((l) => l.target.kind === 'track' && l.target.param === 'pan') && <option value="+pan">+ Pan</option>}
            {otherTracks.length > 0 && (
              <optgroup label="Sidechain">
                {otherTracks.map((o) => (
                  <option key={o.id} value={`duck:${o.id}`}>
                    ⇣ Duck from {o.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            title="Delete track"
            onClick={() => {
              if (confirm(`Delete track "${track.name}" and its clips?`)) removeTrack(track.id);
            }}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded text-dim hover:bg-panel hover:text-bad"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pr-1.5">
        <AutoKnob
          trackId={track.id}
          target={PAN_TARGET}
          spec={PAN_SPEC}
          value={track.pan}
          size={26}
          label="Pan"
          onChange={(v) => updateTrack(track.id, { pan: Math.abs(v) < 0.02 ? 0 : v }, 'Pan', { coalesce: `pan-${track.id}` })}
        />
        <Meter source={track.id} width={7} height={TRACK_H - 22} />
      </div>
    </div>
  );
}
