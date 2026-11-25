/**
 * Instrument registry — audio part: how each instrument type builds and
 * updates its node. Works on any BaseAudioContext (realtime or offline).
 */
import type { InstrumentType } from '../instruments/definitions';
import type { InstrumentConfig } from '../project/types';
import type { SynthEvent } from '../synth/dsp/TriOscCore';
import { DrumRackInstrument } from './drumRack';
import { TriOscInstrument } from './trioscNode';

/** What the transport and engine need from any instrument. */
export interface InstrumentNode {
  readonly output: AudioNode;
  schedule(events: SynthEvent[]): void;
  noteOn(id: number, note: number, velocity: number, time?: number): void;
  noteOff(id: number, time?: number): void;
  sustain(on: boolean, time?: number): void;
  pitchBend(value: number, time?: number): void;
  cancel(time: number): void;
  allNotesOff(time?: number): void;
  panic(): void;
  dispose(): void;
  /** instrument-parameter keys currently driven by automation lanes */
  setAutomatedKeys(keys: string[]): void;
  /** jump an automated parameter to a value (used while stopped / seeking) */
  setAutomationValue(key: string, value: number): void;
}

export interface InstrumentEnv {
  /** decoded sample assets by id */
  resolveAsset: (id: string) => AudioBuffer | undefined;
  /** events known up front (offline export) */
  events?: SynthEvent[];
}

interface AudioFactory<T extends InstrumentType> {
  create(ctx: BaseAudioContext, config: Extract<InstrumentConfig, { type: T }>, env: InstrumentEnv): InstrumentNode;
  /** apply a new config of the same type in place; return false if the node must be rebuilt */
  update(node: InstrumentNode, config: Extract<InstrumentConfig, { type: T }>): boolean;
}

export const INSTRUMENT_AUDIO: { [T in InstrumentType]: AudioFactory<T> } = {
  triosc: {
    create: (ctx, c, env) => new TriOscInstrument(ctx, c.patch, env.events),
    update: (node, c) => {
      if (!(node instanceof TriOscInstrument)) return false;
      node.setPatch(c.patch);
      return true;
    },
  },
  drumrack: {
    create: (ctx, c, env) => {
      const d = new DrumRackInstrument(ctx, c.kit, env.resolveAsset);
      if (env.events) d.schedule(env.events);
      return d;
    },
    update: (node, c) => {
      if (!(node instanceof DrumRackInstrument)) return false;
      node.setKit(c.kit);
      return true;
    },
  },
};

export function createInstrumentNode(ctx: BaseAudioContext, config: InstrumentConfig, env: InstrumentEnv): InstrumentNode {
  return (INSTRUMENT_AUDIO[config.type] as AudioFactory<InstrumentType>).create(ctx, config as never, env);
}

export function updateInstrumentNode(node: InstrumentNode, config: InstrumentConfig): boolean {
  return (INSTRUMENT_AUDIO[config.type] as AudioFactory<InstrumentType>).update(node, config as never);
}
