/** Store commands for insert effects. Every change is an undoable project edit. */
import { createEffectSlot, EFFECT_LABELS } from '../audio/effects/specs';
import { addEffectSlot, moveEffectSlot, removeEffectSlot, updateEffectSlot, withParams } from '../project/effectOps';
import { MAX_EFFECT_SLOTS, type EffectSlot, type EffectType, type Project } from '../project/types';
import { useProjectStore, type CommitOptions } from './projectStore';
import { uiToast } from './uiStore';

function editChain(trackId: string, label: string, fn: (chain: EffectSlot[]) => EffectSlot[] | null, opts: CommitOptions = {}): boolean {
  let ok = true;
  useProjectStore.getState().commit(
    label,
    (p: Project) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) return p;
      const next = fn(track.effects);
      if (!next) {
        ok = false;
        return p;
      }
      if (next === track.effects) return p;
      return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, effects: next } : t)) };
    },
    opts,
  );
  return ok;
}

export function addEffect(trackId: string, type: EffectType, index?: number): EffectSlot | null {
  const slot = createEffectSlot(type);
  const ok = editChain(trackId, `Add ${EFFECT_LABELS[type]}`, (c) => addEffectSlot(c, slot, index));
  if (!ok) {
    uiToast('error', `A track can hold at most ${MAX_EFFECT_SLOTS} effects.`);
    return null;
  }
  return slot;
}

export function removeEffect(trackId: string, slotId: string): void {
  // removing an effect also removes the automation lanes that targeted it (one undo step)
  useProjectStore.getState().commit('Remove effect', (p: Project) => ({
    ...p,
    tracks: p.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            effects: removeEffectSlot(t.effects, slotId),
            automation: t.automation.filter((l) => !(l.target.kind === 'fx' && l.target.slotId === slotId)),
            modulations: t.modulations.filter((m) => !(m.target.kind === 'fx' && m.target.slotId === slotId)),
          }
        : t,
    ),
  }));
}

export function moveEffect(trackId: string, slotId: string, delta: number): void {
  editChain(trackId, 'Reorder effects', (c) => moveEffectSlot(c, slotId, delta));
}

export function setEffectEnabled(trackId: string, slotId: string, enabled: boolean): void {
  editChain(trackId, enabled ? 'Enable effect' : 'Bypass effect', (c) => updateEffectSlot(c, slotId, (s) => ({ ...s, enabled })));
}

export function setEffectParams(trackId: string, slotId: string, params: Partial<EffectSlot['params']>, coalesce?: string): void {
  editChain(trackId, 'Edit effect', (c) => updateEffectSlot(c, slotId, (s) => withParams(s, params)), coalesce ? { coalesce } : {});
}

export function replaceEffectParams(trackId: string, slotId: string, params: EffectSlot['params'], label: string): void {
  editChain(trackId, label, (c) => updateEffectSlot(c, slotId, (s) => ({ ...s, params: { ...params } }) as EffectSlot));
}
