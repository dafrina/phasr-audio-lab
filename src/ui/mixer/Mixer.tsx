import { useLayoutEffect, useRef, useState } from 'react';
import { Activity, AudioLines, Music, Shield } from 'lucide-react';
import { EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
import { MASTER_ID, MAX_EFFECT_SLOTS, SEND_IDS, sendLabel, sendsTo, type EffectSlot, type EffectType, type Track } from '../../project/types';
import { addEffect, setEffectEnabled, setTrackSend, updateSendBus } from '../../state/effectActions';
import { Knob } from '../common/Knob';
import type { NumericParamSpec } from '../../synth/params';
import { updateProjectFields, updateTrack, useProjectStore } from '../../state/projectStore';
import { openTrackDevices, useUiStore } from '../../state/uiStore';
import { PARAM_SPECS } from '../../synth/params';
import { AutoKnob, useAutomatedValue } from '../common/AutoKnob';
import { endAutomationGesture, writeAutomation } from '../../state/automationActions';
import type { AutomationTarget } from '../../project/types';

const VOL_TARGET: AutomationTarget = { kind: 'track', param: 'volumeDb' };
const PAN_TARGET: AutomationTarget = { kind: 'track', param: 'pan' };
import { Meter } from '../common/Meter';
import { ToggleChip } from '../common/controls';
import { formatDb } from '../timeline/TrackHeader';
import { VFader } from './VFader';

/** Eight channel strips plus the master strip. Every control drives the audio engine. */
export function Mixer() {
  const tracks = useProjectStore((s) => s.project.tracks);
  const master = useProjectStore((s) => s.project.master);
  const wrap = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(300);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // vertical space left for the fader after the fixed parts of the strip
  const faderH = Math.max(60, h - 282);
  return (
    <div ref={wrap} className="flex h-full min-h-0 items-stretch gap-1 overflow-x-auto bg-panel p-1.5">
      {tracks.map((t, i) => (
        <ChannelStrip key={t.id} track={t} index={i} faderH={faderH} />
      ))}
      {tracks.length === 0 && <div className="p-4 text-muted">No tracks.</div>}
      <div className="ml-auto flex shrink-0 gap-1">
        {SEND_IDS.map((_, k) => (
          <SendStrip key={k} k={k} faderH={faderH} />
        ))}
      </div>
      <div className="flex w-[104px] shrink-0 flex-col items-center gap-1.5 rounded-md border border-line-2 bg-panel-3 px-1.5 py-1.5">
        <div className="flex w-full items-center justify-center gap-1 text-[11px] font-semibold tracking-[0.14em] text-fg">
          MASTER
          <AnalyzerButton id={MASTER_ID} label="the master" />
        </div>
        <FxSlots ownerId={MASTER_ID} effects={master.effects ?? []} />
        <button
          type="button"
          title={master.limiter ? 'Safety limiter on (catches peaks above -1 dBFS). Click to bypass.' : 'Safety limiter bypassed. Click to enable.'}
          onClick={() => updateProjectFields('Toggle limiter', { master: { ...master, limiter: !master.limiter } })}
          className={`flex h-5 w-full items-center justify-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wide ${
            master.limiter ? 'bg-accent text-white' : 'bg-panel text-muted'
          }`}
        >
          <Shield size={10} /> Limiter
        </button>
        <div className="flex-1" />
        <div className="flex items-end gap-1.5">
          <VFader
            db={master.volumeDb}
            height={faderH + 46}
            title="Master volume"
            onChange={(v) => updateProjectFields('Master volume', { master: { ...master, volumeDb: v } }, 'master-vol')}
          />
          <Meter source="master" width={14} height={faderH + 40} />
        </div>
        <div className="font-mono text-[10px] text-muted">{formatDb(master.volumeDb)} dB</div>
      </div>
    </div>
  );
}

function ChannelStrip({ track, index, faderH }: { track: Track; index: number; faderH: number }) {
  const selected = useUiStore((s) => s.selectedTrackId === track.id);
  const setUi = useUiStore((s) => s.set);
  const anySolo = useProjectStore((s) => s.project.tracks.some((t) => t.solo));
  const audible = !track.mute && (!anySolo || track.solo);
  const vol = useAutomatedValue(track.id, VOL_TARGET, track.volumeDb);
  const gesture = useRef('');
  return (
    <div
      onPointerDown={() => setUi({ selectedTrackId: track.id })}
      className={`flex w-[96px] shrink-0 flex-col items-center gap-1.5 rounded-md border px-1.5 pb-1.5 ${selected ? 'border-line-2 bg-panel-3' : 'border-line bg-panel-2'} ${audible ? '' : 'opacity-70'}`}
    >
      <div className="-mx-1.5 h-1 w-[calc(100%+12px)] rounded-t-md" style={{ background: track.color }} />
      <div className="flex w-full items-center gap-1">
        <span className="text-muted">{track.kind === 'audio' ? <AudioLines size={11} /> : <Music size={11} />}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg" title={track.name}>
          {track.name}
        </span>
        <span className="font-mono text-[9px] text-dim">{index + 1}</span>
        <AnalyzerButton id={track.id} label={track.name} />
      </div>
      <FxSlots ownerId={track.id} effects={track.effects} />
      <SendKnobs track={track} />
      <AutoKnob
        trackId={track.id}
        target={PAN_TARGET}
        spec={PARAM_SPECS.pan}
        value={track.pan}
        size={28}
        label="Pan"
        onChange={(v) => updateTrack(track.id, { pan: Math.abs(v) < 0.02 ? 0 : v }, 'Pan', { coalesce: `pan-${track.id}` })}
      />
      <div className="flex gap-1">
        <ToggleChip on={track.mute} label="M" title="Mute" onClass="bg-warn text-black" onClick={() => updateTrack(track.id, { mute: !track.mute }, 'Mute')} />
        <ToggleChip on={track.solo} label="S" title="Solo" onClass="bg-ok text-black" onClick={() => updateTrack(track.id, { solo: !track.solo }, 'Solo')} />
      </div>
      <div className="flex flex-1 items-end gap-1.5">
        <div onPointerDown={() => (gesture.current = `mixvol-${track.id}-${Date.now()}`)} onPointerUp={() => endAutomationGesture(gesture.current)}>
          <VFader
            db={vol.value}
            height={faderH}
            title={`${track.name} volume${vol.automated ? ' (automated)' : ''}`}
            onChange={(v) => {
              if (vol.automated) writeAutomation(track.id, VOL_TARGET, v, gesture.current || `mixvol-${track.id}`);
              else updateTrack(track.id, { volumeDb: v }, 'Volume', { coalesce: `vol-${track.id}` });
            }}
          />
        </div>
        <Meter source={track.id} width={12} height={faderH - 6} />
      </div>
      <div className={`font-mono text-[10px] ${vol.automated ? 'text-[#f472b6]' : 'text-muted'}`}>{formatDb(vol.value)} dB</div>
    </div>
  );
}

/** Opens the analyser window (spectrum / spectrogram / scope) on a channel; lit while it shows that one. */
function AnalyzerButton({ id, label }: { id: string; label: string }) {
  const on = useUiStore((s) => s.analyzerTrackId === id);
  return (
    <button
      type="button"
      data-testid={`analyzer-open-${id}`}
      title={on ? `Close the analyser of ${label}` : `Analyser for ${label}: spectrum, spectrogram and oscilloscope`}
      onClick={(e) => {
        e.stopPropagation();
        useUiStore.getState().set({ analyzerTrackId: on ? null : id });
      }}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${on ? 'bg-[#38bdf8] text-black' : 'text-dim hover:bg-panel hover:text-fg'}`}
    >
      <Activity size={10} />
    </button>
  );
}

/** The insert-effect slots of a strip (a track's, or the master's with ownerId = MASTER_ID). */
function FxSlots({ ownerId, effects }: { ownerId: string; effects: readonly EffectSlot[] }) {
  return (
      <div className="flex w-full flex-col gap-0.5" title="Insert effects (click to edit)">
        {Array.from({ length: MAX_EFFECT_SLOTS }, (_, i) => {
          const slot = effects[i];
          if (slot) {
            return (
              <div key={slot.id} className="flex h-[18px] items-center gap-1 rounded bg-base px-1">
                <button
                  type="button"
                  title={slot.enabled ? 'Bypass' : 'Enable'}
                  onClick={() => setEffectEnabled(ownerId, slot.id, !slot.enabled)}
                  className={`h-2 w-2 shrink-0 rounded-full ${slot.enabled ? 'bg-ok' : 'bg-dim'}`}
                />
                <button
                  type="button"
                  onClick={() => openTrackDevices(ownerId)}
                  className={`min-w-0 flex-1 truncate text-left text-[10px] ${slot.enabled ? 'text-fg' : 'text-dim line-through'}`}
                >
                  {EFFECT_LABELS[slot.type]}
                </button>
              </div>
            );
          }
          if (i === effects.length) {
            return (
              <select
                key={`empty-${i}`}
                value=""
                title="Add an insert effect"
                onChange={(e) => {
                  if (!e.target.value) return;
                  addEffect(ownerId, e.target.value as EffectType);
                  openTrackDevices(ownerId);
                }}
                className="h-[18px] w-full !bg-base !py-0 text-[10px] !text-dim"
              >
                <option value="">+ add…</option>
                {EFFECT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EFFECT_LABELS[t]}
                  </option>
                ))}
              </select>
            );
          }
          return <div key={`empty-${i}`} className="h-[18px] rounded bg-base/50" />;
        })}
      </div>
  );
}

/** Send knob: 0 = off, 1 = unity (squared law, so the useful low levels get most of the travel). */
export const SEND_SPEC: NumericParamSpec = {
  label: 'Send',
  min: 0,
  max: 1,
  default: 0,
  curve: 'linear',
  format: (v) => (v <= 0.001 ? 'off' : `${(20 * Math.log10(v * v)).toFixed(1)} dB`),
};

/** A track's two Send knobs (to send channels A and B). */
export function SendKnobs({ track, size = 24 }: { track: Track; size?: number }) {
  const sends = useProjectStore((s) => s.project.sends);
  return (
    <div className="flex w-full items-start justify-center gap-1.5">
      {SEND_IDS.map((id, k) => {
        const bus = sends[k];
        const v = track.sends?.[k] ?? 0;
        const name = bus ? sendLabel(bus, (t) => EFFECT_LABELS[t], true) : id;
        return (
          <Knob
            key={id}
            spec={SEND_SPEC}
            value={v}
            size={size}
            label={k === 0 ? 'Send A' : 'Send B'}
            color={k === 0 ? '#38bdf8' : '#fb923c'}
            title={`Send to ${name}: ${SEND_SPEC.format(v)} — how much of this track goes to that shared channel (after the fader). Double-click: off`}
            onChange={(x) => setTrackSend(track.id, k, x < 0.01 ? 0 : x, `send-${track.id}-${k}`)}
          />
        );
      })}
    </div>
  );
}

/** A send channel's strip: what's in it, its effects, fader, mute and meter. */
function SendStrip({ k, faderH }: { k: number; faderH: number }) {
  const bus = useProjectStore((s) => s.project.sends[k]);
  const senders = useProjectStore((s) => s.project.tracks.filter((t) => sendsTo(t, k)).length);
  if (!bus) return null;
  const id = SEND_IDS[k] as string;
  return (
    <div className="flex w-[96px] shrink-0 flex-col items-center gap-1.5 rounded-md border border-dashed border-line-2 bg-panel-2 px-1.5 pb-1.5">
      <div className="-mx-1.5 h-1 w-[calc(100%+12px)] rounded-t-md" style={{ background: k === 0 ? '#38bdf8' : '#fb923c' }} />
      <div className="flex w-full items-center gap-1">
        <button type="button" onClick={() => openTrackDevices(id)} className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-fg hover:text-accent-hi" title="Open this send channel's effects">
          {sendLabel(bus, (t) => EFFECT_LABELS[t], true)}
        </button>
        <AnalyzerButton id={id} label={`send ${k === 0 ? 'A' : 'B'}`} />
      </div>
      <FxSlots ownerId={id} effects={bus.effects} />
      <div className="text-center text-[9px] leading-tight text-dim" title="Tracks whose Send knob is up">
        {senders ? `${senders} track${senders === 1 ? '' : 's'} sending` : 'turn up a Send knob'}
      </div>
      <div className="flex gap-1">
        <ToggleChip on={bus.mute} label="M" title="Mute" onClass="bg-warn text-black" onClick={() => updateSendBus(k, { mute: !bus.mute }, bus.mute ? 'Unmute send' : 'Mute send')} />
      </div>
      <div className="flex-1" />
      <div className="flex items-end gap-1">
        <VFader db={bus.volumeDb} height={faderH + 46} title="Send channel volume" onChange={(v) => updateSendBus(k, { volumeDb: v }, 'Send volume', `send-vol-${k}`)} />
        <Meter source={id} width={12} height={faderH + 40} />
      </div>
      <div className="font-mono text-[10px] text-muted">{formatDb(bus.volumeDb)} dB</div>
    </div>
  );
}
