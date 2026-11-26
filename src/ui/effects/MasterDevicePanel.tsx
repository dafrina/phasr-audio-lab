import { ArrowRight, Plus, Send, Shield, SlidersVertical } from 'lucide-react';
import { EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
import { MASTER_ID, MAX_EFFECT_SLOTS, SEND_IDS, sendLabel } from '../../project/types';
import { addEffect, updateSendBus } from '../../state/effectActions';
import { updateProjectFields, useProjectStore } from '../../state/projectStore';
import { Meter } from '../common/Meter';
import { EffectDevice } from './EffectDevice';

/**
 * Bottom-panel view of the master bus (all tracks → its effects → fader →
 * limiter) or of a send channel (the tracks' sends → its effects → fader →
 * master). Same effect devices as on a track.
 */
export function MasterDevicePanel({ busId = MASTER_ID }: { busId?: string }) {
  const master = useProjectStore((s) => s.project.master);
  const k = (SEND_IDS as readonly string[]).indexOf(busId);
  const bus = useProjectStore((s) => (k >= 0 ? s.project.sends[k] : undefined));
  const tracks = useProjectStore((s) => s.project.tracks);
  const trackCount = tracks.length;
  const isSend = !!bus;
  const effects = (bus ? bus.effects : master.effects) ?? [];
  const full = effects.length >= MAX_EFFECT_SLOTS;
  const senders = bus ? tracks.filter((t) => (t.sends?.[k] ?? 0) > 0) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2 text-[11px]">
        {isSend ? <Send size={13} className="text-muted" /> : <SlidersVertical size={13} className="text-muted" />}
        <span className="font-medium text-fg">{bus ? `Send ${sendLabel(bus, (t) => EFFECT_LABELS[t])}` : 'Master'}</span>
        <span className="text-dim">
          {isSend
            ? `effects ${effects.length}/${MAX_EFFECT_SLOTS} · tracks' Send ${k === 0 ? 'A' : 'B'} knobs → effects (left → right) → fader → master. Use it for anything several tracks share: a reverb, a delay, a chorus…`
            : `insert effects ${effects.length}/${MAX_EFFECT_SLOTS} · all tracks → effects (left → right) → master fader → limiter → out`}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-start gap-2 overflow-auto p-2">
        <div className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-line bg-panel-2 p-2 text-center">
          {isSend ? <Send size={20} className="text-accent-hi" /> : <SlidersVertical size={20} className="text-accent-hi" />}
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">{isSend ? 'Sends' : 'All tracks'}</div>
          {isSend ? (
            <div className="text-[10px] leading-tight text-muted">
              {senders.length ? senders.map((t) => `${t.name} ${Math.round((t.sends[k] ?? 0) * 100)}%`).join(' · ') : 'No track sends here yet — turn up a track’s Send knob in the mixer'}
            </div>
          ) : (
            <div className="text-[10px] text-muted">{trackCount} summed</div>
          )}
        </div>
        {effects.map((slot, i) => (
          <div key={slot.id} className="flex items-center gap-2">
            <ArrowRight size={14} className="shrink-0 text-dim" />
            <EffectDevice trackId={busId} slot={slot} index={i} count={effects.length} />
          </div>
        ))}
        {/* hidden once the chain is full ({MAX_EFFECT_SLOTS} effects) */}
        {!full && (
          <div className="flex items-center gap-2">
            <ArrowRight size={14} className="shrink-0 text-dim" />
            <div className="flex w-[130px] shrink-0 flex-col justify-center gap-1 rounded-md border border-dashed border-line-2 p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
                <Plus size={11} /> Add effect
              </div>
              {EFFECT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={`Insert ${EFFECT_LABELS[t]} at the end of the chain`}
                  onClick={() => addEffect(busId, t)}
                  className="h-6 rounded bg-panel-3 text-left text-[11px] text-fg hover:bg-line-2"
                >
                  <span className="px-2">{EFFECT_LABELS[t]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <ArrowRight size={14} className="mt-[68px] shrink-0 text-dim" />
        <div className="flex h-[150px] w-[120px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-line bg-panel-2 p-2 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">Fader</div>
          <div className="font-mono text-[11px] text-muted">{(bus ? bus.volumeDb : master.volumeDb).toFixed(1)} dB</div>
          {bus ? (
            <button
              type="button"
              title={bus.mute ? 'Muted — click to unmute' : 'Mute this send channel'}
              onClick={() => updateSendBus(k, { mute: !bus.mute }, bus.mute ? 'Unmute send' : 'Mute send')}
              className={`flex h-5 w-full items-center justify-center rounded text-[10px] font-semibold uppercase tracking-wide ${bus.mute ? 'bg-warn text-black' : 'bg-panel text-muted'}`}
            >
              Mute
            </button>
          ) : (
          <button
            type="button"
            title={master.limiter ? 'Safety limiter on (catches peaks above -1 dBFS). Click to bypass.' : 'Safety limiter bypassed. Click to enable.'}
            onClick={() => updateProjectFields('Toggle limiter', { master: { ...master, limiter: !master.limiter } })}
            className={`flex h-5 w-full items-center justify-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wide ${master.limiter ? 'bg-accent text-white' : 'bg-panel text-muted'}`}
          >
            <Shield size={10} /> Limiter
          </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <Meter source={bus ? busId : 'master'} width={10} height={120} />
        </div>
      </div>
    </div>
  );
}
