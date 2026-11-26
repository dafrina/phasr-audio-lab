/**
 * A plain insert chain: input → effect units… → output, synced in place from
 * effect slots (the master bus uses it; tracks have their own chain with
 * sidechain taps in TrackChannel). Reordering rewires under a ~12 ms duck in
 * realtime, so it never clicks.
 */
import type { EffectSlot } from '../project/types';
import { createEffectUnit, type EffectUnit } from './effects/units';

export class EffectChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly realtime: boolean;
  private readonly units = new Map<string, EffectUnit>();
  private chainOrder: string[] = [];
  private wantedOrder: string[] = [];
  private rewireTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: BaseAudioContext, realtime: boolean) {
    this.ctx = ctx;
    this.realtime = realtime;
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    this.input.connect(this.output);
  }

  sync(slots: readonly EffectSlot[], bpm: number): void {
    for (const slot of slots) {
      const unit = this.units.get(slot.id);
      if (unit && unit.type === slot.type) unit.update(slot, bpm);
      else {
        unit?.dispose();
        this.units.set(slot.id, createEffectUnit(this.ctx, slot, bpm));
        this.chainOrder = this.chainOrder.filter((id) => id !== slot.id); // force rewire
      }
    }
    this.wantedOrder = slots.map((s) => s.id);
    const same = this.wantedOrder.length === this.chainOrder.length && this.wantedOrder.every((id, i) => id === this.chainOrder[i]);
    if (same) return;
    if (!this.realtime) {
      this.rewire();
      return;
    }
    if (this.rewireTimer) return; // pending; it uses the latest order
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.002);
    this.rewireTimer = setTimeout(() => {
      this.rewireTimer = null;
      this.rewire();
      this.output.gain.setTargetAtTime(1, this.ctx.currentTime, 0.003);
    }, 12);
  }

  private rewire(): void {
    this.input.disconnect();
    for (const u of this.units.values()) u.output.disconnect();
    let prev: AudioNode = this.input;
    for (const id of this.wantedOrder) {
      const u = this.units.get(id);
      if (!u) continue;
      prev.connect(u.input);
      prev = u.output;
    }
    prev.connect(this.output);
    for (const [id, u] of this.units) {
      if (!this.wantedOrder.includes(id)) {
        u.dispose();
        this.units.delete(id);
      }
    }
    this.chainOrder = [...this.wantedOrder];
  }

  unit(id: string): EffectUnit | undefined {
    return this.units.get(id);
  }

  dispose(): void {
    if (this.rewireTimer) clearTimeout(this.rewireTimer);
    for (const u of this.units.values()) u.dispose();
    this.units.clear();
    this.input.disconnect();
    this.output.disconnect();
  }
}
