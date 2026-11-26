import { ArrowRight, Plus, Shield, SlidersVertical } from 'lucide-react';
import { EFFECT_LABELS, EFFECT_TYPES } from '../../audio/effects/specs';
import { MASTER_ID, MAX_EFFECT_SLOTS } from '../../project/types';
import { addEffect } from '../../state/effectActions';
import { updateProjectFields, useProjectStore } from '../../state/projectStore';
import { Meter } from '../common/Meter';
import { EffectDevice } from './EffectDevice';

/**
 * Bottom-panel view of the master bus: the sum of all tracks through the
 * master's insert effects (a glue compressor, a final EQ …), then the master
 * fader and the safety limiter.
 */
export function MasterDevicePanel() {
  const master = useProjectStore((s) => s.project.master);
  const trackCount = useProjectStore((s) => s.project.tracks.length);
  const effects = master.effects ?? [];
  const full = effects.length >= MAX_EFFECT_SLOTS;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2 text-[11px]">
        <SlidersVertical size={13} className="text-muted" />
        <span className="font-medium text-fg">Master</span>
        <span className="text-dim">
          insert effects {effects.length}/{MAX_EFFECT_SLOTS} · all tracks → effects (left → right) → master fader → limiter → out
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-start gap-2 overflow-auto p-2">
        <div className="flex h-[150px] w-[150px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-line bg-panel-2 p-2 text-center">
          <SlidersVertical size={20} className="text-accent-hi" />
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">All tracks</div>
          <div className="text-[10px] text-muted">{trackCount} summed</div>
        </div>
        {effects.map((slot, i) => (
          <div key={slot.id} className="flex items-center gap-2">
            <ArrowRight size={14} className="shrink-0 text-dim" />
            <EffectDevice trackId={MASTER_ID} slot={slot} index={i} count={effects.length} />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <ArrowRight size={14} className="shrink-0 text-dim" />
          <div className={`flex w-[130px] shrink-0 flex-col justify-center gap-1 rounded-md border border-dashed border-line-2 p-2 ${full ? 'opacity-40' : ''}`}>
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
              <Plus size={11} /> Add effect
            </div>
            {EFFECT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                disabled={full}
                title={full ? `Maximum ${MAX_EFFECT_SLOTS} effects on the master` : `Insert ${EFFECT_LABELS[t]} at the end of the master chain`}
                onClick={() => addEffect(MASTER_ID, t)}
                className="h-6 rounded bg-panel-3 text-left text-[11px] text-fg hover:bg-line-2 disabled:cursor-not-allowed"
              >
                <span className="px-2">{EFFECT_LABELS[t]}</span>
              </button>
            ))}
          </div>
        </div>
        <ArrowRight size={14} className="mt-[68px] shrink-0 text-dim" />
        <div className="flex h-[150px] w-[120px] shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-line bg-panel-2 p-2 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg">Fader</div>
          <div className="font-mono text-[11px] text-muted">{master.volumeDb.toFixed(1)} dB</div>
          <button
            type="button"
            title={master.limiter ? 'Safety limiter on (catches peaks above -1 dBFS). Click to bypass.' : 'Safety limiter bypassed. Click to enable.'}
            onClick={() => updateProjectFields('Toggle limiter', { master: { ...master, limiter: !master.limiter } })}
            className={`flex h-5 w-full items-center justify-center gap-1 rounded text-[10px] font-semibold uppercase tracking-wide ${master.limiter ? 'bg-accent text-white' : 'bg-panel text-muted'}`}
          >
            <Shield size={10} /> Limiter
          </button>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <Meter source="master" width={10} height={120} />
        </div>
      </div>
    </div>
  );
}
