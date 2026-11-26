/** Store commands for insert effects. Every change is an undoable project edit. */
import { createEffectSlot, EFFECT_LABELS } from '../audio/effects/specs';
import { addEffectSlot, moveEffectSlot, removeEffectSlot, updateEffectSlot, withParams } from '../project/effectOps';
import { MASTER_ID, MAX_EFFECT_SLOTS, SEND_IDS, isBusId, type EffectSlot, type EffectType, type Project } from '../project/types';
import { useProjectStore, type CommitOptions } from './projectStore';
import { uiToast } from './uiStore';

function editChain(trackId: string, label: string, fn: (chain: EffectSlot[]) => EffectSlot[] | null, opts: CommitOptions = {}): boolean {
  let ok = true;
  useProjectStore.getState().commit(
    label,
    (p: Project) => {
      if (trackId === MASTER_ID) {
        const cur = p.master.effects ?? [];
        const next = fn(cur);
        if (!next) {
          ok = false;
          return p;
        }
        return next === cur ? p : { ...p, master: { ...p.master, effects: next } };
      }
      const k = (SEND_IDS as readonly string[]).indexOf(trackId);
      if (k >= 0) {
        const bus = p.sends[k];
        if (!bus) return p;
        const next = fn(bus.effects);
        if (!next) {
          ok = false;
          return p;
        }
        return next === bus.effects ? p : { ...p, sends: p.sends.map((b, j) => (j === k ? { ...b, effects: next } : b)) };
      }
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
    uiToast('error', `${trackId === MASTER_ID ? 'The master' : isBusId(trackId) ? 'A send channel' : 'A track'} can hold at most ${MAX_EFFECT_SLOTS} effects.`);
    return null;
  }
  return slot;
}

export function removeEffect(trackId: string, slotId: string): void {
  if (isBusId(trackId)) {
    editChain(trackId, 'Remove effect', (c) => removeEffectSlot(c, slotId));
    return;
  }
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

/** A track's send level (0..1) to send channel k. */
export function setTrackSend(trackId: string, k: number, level: number, coalesce?: string): void {
  const v = Math.max(0, Math.min(1, level));
  useProjectStore.getState().commit(
    'Send level',
    (p: Project) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, sends: Array.from({ length: SEND_IDS.length }, (_, j) => (j === k ? v : (t.sends?.[j] ?? 0))) } : t)),
    }),
    coalesce ? { coalesce } : {},
  );
}

/** Fader / mute of send channel k. */
export function updateSendBus(k: number, fields: { volumeDb?: number; mute?: boolean }, label: string, coalesce?: string): void {
  useProjectStore.getState().commit(label, (p: Project) => ({ ...p, sends: p.sends.map((b, j) => (j === k ? { ...b, ...fields } : b)) }), coalesce ? { coalesce } : {});
}
