import { useLayoutEffect, useRef, useState } from 'react';
import { AudioLines, Music, Shield } from 'lucide-react';
import { EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
import { MAX_EFFECT_SLOTS, type EffectType, type Track } from '../../project/types';
import { addEffect, setEffectEnabled } from '../../state/effectActions';
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
  const faderH = Math.max(60, h - 236);
  return (
    <div ref={wrap} className="flex h-full min-h-0 items-stretch gap-1 overflow-x-auto bg-panel p-1.5">
      {tracks.map((t, i) => (
        <ChannelStrip key={t.id} track={t} index={i} faderH={faderH} />
      ))}
      {tracks.length === 0 && <div className="p-4 text-muted">No tracks.</div>}
      <div className="ml-auto flex w-[104px] shrink-0 flex-col items-center gap-1.5 rounded-md border border-line-2 bg-panel-3 px-1.5 py-1.5">
        <div className="flex w-full items-center justify-center gap-1 text-[11px] font-semibold tracking-[0.14em] text-fg">MASTER</div>
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
      </div>
      <div className="flex w-full flex-col gap-0.5" title="Insert effects (click to edit)">
        {Array.from({ length: MAX_EFFECT_SLOTS }, (_, i) => {
          const slot = track.effects[i];
          if (slot) {
            return (
              <div key={slot.id} className="flex h-[18px] items-center gap-1 rounded bg-base px-1">
                <button
                  type="button"
                  title={slot.enabled ? 'Bypass' : 'Enable'}
                  onClick={() => setEffectEnabled(track.id, slot.id, !slot.enabled)}
                  className={`h-2 w-2 shrink-0 rounded-full ${slot.enabled ? 'bg-ok' : 'bg-dim'}`}
                />
                <button
                  type="button"
                  onClick={() => openTrackDevices(track.id)}
                  className={`min-w-0 flex-1 truncate text-left text-[10px] ${slot.enabled ? 'text-fg' : 'text-dim line-through'}`}
                >
                  {EFFECT_LABELS[slot.type]}
                </button>
              </div>
            );
          }
          if (i === track.effects.length) {
            return (
              <select
                key={`empty-${i}`}
                value=""
                title="Add an insert effect"
                onChange={(e) => {
                  if (!e.target.value) return;
                  addEffect(track.id, e.target.value as EffectType);
                  openTrackDevices(track.id);
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
