/**
 * Keyforge synth: owns the active engine, swaps engines on preset changes
 * (the previous engine's tail fades out instead of cutting off) and keeps
 * pedal/bend state across swaps.
 */
import { KEYS_ENGINES, defaultKeysParams, sanitizeKeysParams, type KeysConfigData, type KeysEngineType } from '../params';
import { AnalogEngine, type AnalogParams } from './analog';
import { MAX_BLOCK, type KeysEngine } from './common';
import { EPianoEngine, type EPianoParams } from './epiano';
import { OrganEngine, type OrganParams } from './organ';
import { PianoEngine, type PianoParams } from './piano';

const SWAP_FADE_SEC = 0.06;

export function createEngine(type: KeysEngineType, sampleRate: number, params: Record<string, number>): KeysEngine {
  switch (type) {
    case 'piano':
      return new PianoEngine(sampleRate, params as unknown as PianoParams);
    case 'epiano':
      return new EPianoEngine(sampleRate, params as unknown as EPianoParams);
    case 'organ':
      return new OrganEngine(sampleRate, params as unknown as OrganParams);
    case 'analog':
      return new AnalogEngine(sampleRate, params as unknown as AnalogParams);
  }
}

export class KeysSynth {
  private readonly sr: number;
  private engineType: KeysEngineType;
  private params: Record<string, number>;
  private engine: KeysEngine;
  private old: KeysEngine | null = null;
  private oldGain = 0;
  private readonly oldStep: number;
  private readonly tmpL = new Float32Array(MAX_BLOCK);
  private readonly tmpR = new Float32Array(MAX_BLOCK);
  private dirty = false;
  private pedal = false;
  private bend = 0;

  constructor(sampleRate: number, config?: KeysConfigData) {
    this.sr = sampleRate;
    this.engineType = config?.engine ?? 'piano';
    this.params = config ? sanitizeKeysParams(this.engineType, config.params) : defaultKeysParams(this.engineType);
    this.engine = createEngine(this.engineType, sampleRate, { ...this.params });
    this.oldStep = 1 / Math.max(1, SWAP_FADE_SEC * sampleRate);
  }

  get engineName(): KeysEngineType {
    return this.engineType;
  }

  getParams(): Record<string, number> {
    return this.params;
  }

  setConfig(config: KeysConfigData): void {
    const params = sanitizeKeysParams(config.engine, config.params);
    if (config.engine !== this.engineType) {
      // fade the old engine's ringing notes out while the new one takes over
      this.engine.allNotesOff();
      this.old = this.engine;
      this.oldGain = 1;
      this.engineType = config.engine;
      this.params = params;
      this.engine = createEngine(config.engine, this.sr, { ...params });
      this.engine.setSustain(this.pedal);
      this.engine.setBend(this.bend);
      this.dirty = false;
      return;
    }
    this.params = params;
    this.dirty = true;
  }

  /** set one parameter (automation); unknown keys are ignored */
  setParam(key: string, value: number): boolean {
    const spec = KEYS_ENGINES[this.engineType].params.find((s) => s.key === key);
    if (!spec || !Number.isFinite(value)) return false;
    const v = Math.min(spec.max, Math.max(spec.min, value));
    if (this.params[key] === v) return true;
    this.params[key] = v;
    this.dirty = true;
    return true;
  }

  noteOn(id: number, note: number, velocity: number): void {
    this.flush();
    this.engine.noteOn(id, note, velocity);
  }

  noteOff(id: number): void {
    this.engine.noteOff(id);
  }

  setSustain(on: boolean): void {
    this.pedal = on;
    this.engine.setSustain(on);
  }

  setPitchBend(value: number): void {
    this.bend = value;
    this.engine.setBend(value);
  }

  allNotesOff(): void {
    this.engine.allNotesOff();
  }

  panic(): void {
    this.engine.panic();
    this.old = null;
    this.pedal = false;
  }

  activeVoices(): number {
    return this.engine.activeVoices() + (this.old ? this.old.activeVoices() : 0);
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.engine.setParams({ ...this.params });
  }

  /** Add `count` frames at `offset` into the outputs. */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    this.flush();
    let pos = offset;
    const end = offset + count;
    while (pos < end) {
      const n = Math.min(MAX_BLOCK, end - pos);
      this.engine.render(outL, outR, pos, n);
      const old = this.old;
      if (old) {
        const tl = this.tmpL;
        const tr = this.tmpR;
        tl.fill(0, 0, n);
        tr.fill(0, 0, n);
        old.render(tl, tr, 0, n);
        let g = this.oldGain;
        for (let i = 0; i < n; i++) {
          g = Math.max(0, g - this.oldStep);
          outL[pos + i] = (outL[pos + i] as number) + (tl[i] as number) * g;
          outR[pos + i] = (outR[pos + i] as number) + (tr[i] as number) * g;
        }
        this.oldGain = g;
        if (g <= 0) this.old = null;
      }
      pos += n;
    }
  }
}
