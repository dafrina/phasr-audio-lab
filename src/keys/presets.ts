/** Keyforge factory presets: an engine plus parameter overrides on its defaults. */
import { defaultKeysParams, type KeysEngineType } from './params';

export interface KeysPreset {
  name: string;
  engine: KeysEngineType;
  category: string;
  params: Record<string, number>;
}

function preset(name: string, engine: KeysEngineType, category: string, o: Record<string, number> = {}): KeysPreset {
  return { name, engine, category, params: { ...defaultKeysParams(engine), ...o } };
}

export const KEYS_PRESETS: KeysPreset[] = [
  preset('Concert Grand', 'piano', 'Piano'),
  preset('Felt Piano', 'piano', 'Piano', { brightness: 0.18, hardness: 0.25, hammerNoise: 0.6, sustain: 0.8, damping: 0.75, unison: 0.8, body: 0.5, tone: 4200, releaseNoise: 0.45, width: 0.4, velCurve: 1.3, master: 0.8 }),
  preset('Bright Upright', 'piano', 'Piano', { brightness: 0.8, hardness: 0.7, hammerNoise: 0.45, sustain: 0.7, damping: 0.35, unison: 3.2, inharm: 1.4, stretch: 1.2, body: 0.45, tone: 16000, width: 0.35 }),
  preset('Classic Tine EP', 'epiano', 'Electric Piano'),
  preset('Suitcase EP', 'epiano', 'Electric Piano', { bark: 0.65, bell: 0.55, hardness: 0.75, tremDepth: 0.55, tremRate: 4.8, drive: 0.4, tone: 6000 }),
  preset('Soft Ballad EP', 'epiano', 'Electric Piano', { bark: 0.15, bell: 0.3, hardness: 0.35, decay: 1.4, tremDepth: 0.2, tremRate: 3, drive: 0.05, tone: 4500 }),
  preset('Jazz Tonewheel', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 0, db4: 0, db5: 0, db6: 0, db7: 0, db8: 0, perc: 1, percHarm: 3, percDecay: 0.25, rotor: 0, rotorMix: 0.85, drive: 0.15, click: 0.55 }),
  preset('Rock Organ', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 8, db4: 0, db5: 0, db6: 0, db7: 0, db8: 8, perc: 0, rotor: 1, rotorMix: 1, drive: 0.75, click: 0.7, master: 0.7 }),
  preset('Gospel Full', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 8, db4: 8, db5: 8, db6: 8, db7: 8, db8: 8, perc: 0, rotor: 1, rotorMix: 0.9, drive: 0.35, master: 0.55 }),
  preset('Warm Pad', 'analog', 'Pad'),
  preset('Glass Pad', 'analog', 'Pad', { unison: 3, detune: 9, sub: 0, noise: 0.06, cutoff: 5200, reso: 0.35, envAmt: -0.15, fAttack: 2.5, fDecay: 4, fSustain: 0.7, attack: 1.8, release: 4.5, ensemble: 0.85, drive: 0 }),
  preset('Techno Stab', 'analog', 'Techno', { unison: 4, detune: 14, spread: 0.6, sub: 0.35, noise: 0, cutoff: 420, reso: 0.55, envAmt: 0.62, keyTrack: 0.5, velFilter: 0.6, fAttack: 0.001, fDecay: 0.22, fSustain: 0, fRelease: 0.2, attack: 0.001, decay: 0.35, sustainLvl: 0.25, release: 0.18, drive: 0.55, ensemble: 0.2 }),
  preset('Acid Line', 'analog', 'Techno', { unison: 1, detune: 0, spread: 0, sub: 0, noise: 0, cutoff: 260, reso: 0.85, envAmt: 0.55, keyTrack: 0.3, velFilter: 0.8, fAttack: 0.001, fDecay: 0.28, fSustain: 0.05, fRelease: 0.1, attack: 0.001, decay: 0.5, sustainLvl: 0.7, release: 0.06, drive: 0.6, ensemble: 0, mono: 1, glide: 0.06, master: 0.65 }),
];

export function keysPreset(name: string): KeysPreset | undefined {
  return KEYS_PRESETS.find((p) => p.name === name);
}
