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
  // full body and a bigger room: the default grand is loud enough to need a little less output
  preset('Concert Grand', 'piano', 'Piano', { master: 0.74 }),
  preset('Felt Piano', 'piano', 'Piano', { brightness: 0.18, hardness: 0.25, hammerNoise: 0.6, sustain: 0.8, damping: 0.75, unison: 0.8, body: 0.5, tone: 4200, releaseNoise: 0.45, width: 0.4, velCurve: 1.3, room: 0.32, master: 0.6 }),
  preset('Bright Upright', 'piano', 'Piano', { brightness: 0.8, hardness: 0.7, hammerNoise: 0.45, sustain: 0.7, damping: 0.35, unison: 3.2, inharm: 1.4, stretch: 1.2, body: 0.45, tone: 16000, width: 0.35, room: 0.12 }),
  preset('Classic Tine EP', 'epiano', 'Electric Piano'),
  preset('Suitcase EP', 'epiano', 'Electric Piano', { bark: 0.65, bell: 0.55, hardness: 0.75, tremDepth: 0.55, tremRate: 4.8, drive: 0.4, tone: 6000 }),
  preset('Soft Ballad EP', 'epiano', 'Electric Piano', { bark: 0.15, bell: 0.3, hardness: 0.35, decay: 1.4, tremDepth: 0.2, tremRate: 3, drive: 0.05, tone: 4500 }),
  preset('Jazz Tonewheel', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 0, db4: 0, db5: 0, db6: 0, db7: 0, db8: 0, perc: 1, percHarm: 3, percDecay: 0.25, rotor: 0, rotorMix: 0.85, drive: 0.15, click: 0.55 }),
  preset('Rock Organ', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 8, db4: 0, db5: 0, db6: 0, db7: 0, db8: 8, perc: 0, rotor: 1, rotorMix: 1, drive: 0.75, click: 0.7, master: 0.7 }),
  preset('Gospel Full', 'organ', 'Organ', { db0: 8, db1: 8, db2: 8, db3: 8, db4: 8, db5: 8, db6: 8, db7: 8, db8: 8, perc: 0, rotor: 1, rotorMix: 0.9, drive: 0.35, master: 0.55 }),
  preset('Warm Pad', 'analog', 'Pad', { space: 0.3 }),
  preset('Glass Pad', 'analog', 'Pad', { unison: 3, detune: 9, sub: 0, noise: 0.06, cutoff: 5200, reso: 0.35, envAmt: -0.15, fAttack: 2.5, fDecay: 4, fSustain: 0.7, attack: 1.8, release: 4.5, ensemble: 0.85, drive: 0, space: 0.45, lfoDepth: 0.3, lfoRate: 0.15 }),
  preset('Techno Stab', 'analog', 'Techno', { unison: 4, detune: 14, spread: 0.6, sub: 0.35, noise: 0, cutoff: 420, reso: 0.55, envAmt: 0.62, keyTrack: 0.5, velFilter: 0.6, fAttack: 0.001, fDecay: 0.22, fSustain: 0, fRelease: 0.2, attack: 0.001, decay: 0.35, sustainLvl: 0.25, release: 0.18, drive: 0.55, ensemble: 0.2 }),
  // melodic techno: big, dark, emotive electronic sounds that live in their reverb and delay
  preset('Cathedral Lead', 'analog', 'Electronic', {
    unison: 7, detune: 26, spread: 1, sub: 0.35, noise: 0.02, cutoff: 2600, reso: 0.22, envAmt: 0.22, keyTrack: 0.5, velFilter: 0.35,
    fAttack: 0.02, fDecay: 1.6, fSustain: 0.45, fRelease: 0.9, attack: 0.008, decay: 1.2, sustainLvl: 0.9, release: 0.9,
    lfoRate: 0.12, lfoDepth: 0.45, space: 0.55, delayMix: 0.32, delayBeats: 0.75, drive: 0.35, ensemble: 0.35, mono: 1, glide: 0.07, master: 0.7,
  }),
  preset('Abyss Bass Lead', 'analog', 'Electronic', {
    unison: 3, detune: 11, spread: 0.45, sub: 0.75, noise: 0, cutoff: 240, reso: 0.5, envAmt: 0.45, keyTrack: 0.35, velFilter: 0.5,
    fAttack: 0.003, fDecay: 0.45, fSustain: 0.22, fRelease: 0.3, attack: 0.002, decay: 0.8, sustainLvl: 0.85, release: 0.25,
    lfoRate: 0.08, lfoDepth: 0.25, space: 0.22, delayMix: 0.12, delayBeats: 0.5, drive: 0.7, ensemble: 0.1, mono: 1, glide: 0.04, master: 0.75,
  }),
  preset('Midnight Pluck', 'analog', 'Electronic', {
    unison: 5, detune: 16, spread: 0.85, sub: 0.15, noise: 0.01, cutoff: 520, reso: 0.48, envAmt: 0.55, keyTrack: 0.6, velFilter: 0.55,
    fAttack: 0.001, fDecay: 0.32, fSustain: 0.04, fRelease: 0.35, attack: 0.001, decay: 0.7, sustainLvl: 0.2, release: 0.45,
    lfoRate: 0.2, lfoDepth: 0.2, space: 0.5, delayMix: 0.45, delayBeats: 0.75, drive: 0.25, ensemble: 0.3, master: 0.85,
  }),
  preset('Acid Line', 'analog', 'Techno', { unison: 1, detune: 0, spread: 0, sub: 0, noise: 0, cutoff: 260, reso: 0.85, envAmt: 0.55, keyTrack: 0.3, velFilter: 0.8, fAttack: 0.001, fDecay: 0.28, fSustain: 0.05, fRelease: 0.1, attack: 0.001, decay: 0.5, sustainLvl: 0.7, release: 0.06, drive: 0.6, ensemble: 0, mono: 1, glide: 0.06, master: 0.65 }),
  // classic electronic sounds everyone recognises (Analog engine)
  preset('Reese Bass', 'analog', 'Techno', { unison: 2, detune: 28, spread: 0.25, sub: 0.5, noise: 0, cutoff: 520, reso: 0.15, envAmt: 0.12, keyTrack: 0.3, velFilter: 0.2, fAttack: 0.001, fDecay: 0.6, fSustain: 0.7, fRelease: 0.3, attack: 0.003, decay: 1, sustainLvl: 1, release: 0.2, lfoRate: 0.2, lfoDepth: 0.35, drive: 0.45, ensemble: 0, mono: 1, glide: 0.04, master: 1.0 }),
  preset('Rave Hoover', 'analog', 'Techno', { unison: 7, detune: 48, spread: 1, sub: 0.15, noise: 0.02, cutoff: 3800, reso: 0.1, envAmt: 0.15, keyTrack: 0.3, velFilter: 0.2, fAttack: 0.02, fDecay: 0.4, fSustain: 0.7, fRelease: 0.4, attack: 0.01, decay: 1, sustainLvl: 0.9, release: 0.35, pitchEnv: -12, pitchTime: 0.35, drive: 0.35, ensemble: 1, mono: 1, glide: 0.18, space: 0.15, master: 0.85 }),
  preset('Supersaw Lead', 'analog', 'Electronic', { unison: 7, detune: 34, spread: 1, sub: 0.1, noise: 0, cutoff: 7000, reso: 0.05, envAmt: 0.1, keyTrack: 0.3, fAttack: 0.001, fDecay: 0.6, fSustain: 0.8, attack: 0.005, decay: 1, sustainLvl: 0.9, release: 0.5, ensemble: 0.7, space: 0.35, delayMix: 0.25, delayBeats: 0.75, drive: 0.05, master: 0.7 }),
  preset('Wobble Bass', 'analog', 'Techno', { unison: 3, detune: 12, spread: 0.3, sub: 0.55, noise: 0, cutoff: 260, reso: 0.55, envAmt: 0, keyTrack: 0.2, velFilter: 0.1, attack: 0.003, decay: 1, sustainLvl: 1, release: 0.12, lfoRate: 2.5, lfoDepth: 2.6, drive: 0.65, ensemble: 0, mono: 1, glide: 0.05, master: 1.0 }),
  preset('Dub Chord', 'analog', 'Techno', { unison: 2, detune: 8, spread: 0.5, sub: 0, noise: 0, cutoff: 700, reso: 0.35, envAmt: 0.45, keyTrack: 0.3, velFilter: 0.4, fAttack: 0.001, fDecay: 0.18, fSustain: 0, fRelease: 0.15, attack: 0.002, decay: 0.35, sustainLvl: 0, release: 0.25, delayMix: 0.55, delayBeats: 0.75, space: 0.45, ensemble: 0.3, drive: 0.15, master: 0.55 }),
  preset('Solina Strings', 'analog', 'Pad', { unison: 4, detune: 14, spread: 0.9, sub: 0, noise: 0, cutoff: 4200, reso: 0, envAmt: 0.05, keyTrack: 0.3, fAttack: 0.3, fDecay: 1, fSustain: 0.9, attack: 0.45, decay: 1, sustainLvl: 0.9, release: 1.6, ensemble: 1, space: 0.4, drive: 0, master: 0.55 }),
  preset('Moog Bass', 'analog', 'Techno', { unison: 1, detune: 0, spread: 0, sub: 0.6, noise: 0, cutoff: 320, reso: 0.45, envAmt: 0.5, keyTrack: 0.4, velFilter: 0.6, fAttack: 0.001, fDecay: 0.22, fSustain: 0.15, fRelease: 0.1, attack: 0.001, decay: 0.6, sustainLvl: 0.8, release: 0.08, drive: 0.5, ensemble: 0, mono: 1, glide: 0.06, master: 1.0 }),
  preset('Donk', 'analog', 'Techno', { unison: 1, detune: 0, spread: 0, sub: 0, noise: 0, cutoff: 900, reso: 0.9, envAmt: 0.55, keyTrack: 0.5, velFilter: 0.3, fAttack: 0.001, fDecay: 0.08, fSustain: 0, fRelease: 0.05, attack: 0.001, decay: 0.18, sustainLvl: 0, release: 0.08, pitchEnv: 12, pitchTime: 0.04, drive: 0.6, ensemble: 0, mono: 1, master: 0.9 }),
  preset('Laser Zap', 'analog', 'Electronic', { unison: 2, detune: 10, spread: 0.5, sub: 0, noise: 0, cutoff: 5000, reso: 0.5, envAmt: 0.2, fAttack: 0.001, fDecay: 0.2, fSustain: 0.3, attack: 0.001, decay: 0.25, sustainLvl: 0, release: 0.1, pitchEnv: 24, pitchTime: 0.12, delayMix: 0.35, delayBeats: 0.75, space: 0.2, drive: 0.2, ensemble: 0.4, master: 0.8 }),
  // the 90s house organ bass (M1-style): bright, percussive, no rotary
  preset('90s House Organ', 'organ', 'Organ', { db0: 8, db1: 8, db2: 6, db3: 0, db4: 4, db5: 0, db6: 0, db7: 0, db8: 0, perc: 1, percHarm: 2, percDecay: 0.2, percLevel: 0.7, rotor: 0, rotorMix: 0, drive: 0.3, click: 0.35, master: 0.9 }),
  // 808 sub basses
  preset('Trap 808', 'sub808', '808', { decay: 2.6, glide: 0.12, drive: 0.35, pitchAmt: 7, click: 0.3 }),
  preset('Long Boom', 'sub808', '808', { decay: 5, release: 0.6, drive: 0.12, tone: 2200, pitchAmt: 5, click: 0.15, punch: 0.25 }),
  preset('Distorted 808', 'sub808', '808', { decay: 2.2, drive: 0.85, tone: 7000, punch: 0.6, click: 0.45, glide: 0.1 }),
  preset('Slide 808', 'sub808', '808', { decay: 3, glide: 0.22, glideMode: 1, drive: 0.3, pitchAmt: 4 }),
  preset('Techno Sub', 'sub808', '808', { decay: 0.55, release: 0.08, pitchAmt: 3, pitchDecay: 0.03, click: 0.1, punch: 0.5, drive: 0.1, tone: 1800, glide: 0 }),
  preset('Sub Drop', 'sub808', '808', { pitchAmt: 24, pitchDecay: 0.3, click: 0, punch: 0.2, decay: 3.5, release: 0.8, drive: 0.2, tone: 3000, glide: 0, master: 0.5 }),
  preset('Kick-Bass', 'sub808', '808', { decay: 0.4, release: 0.05, pitchAmt: 20, pitchDecay: 0.035, click: 0.7, punch: 0.8, drive: 0.4, glide: 0 }),
];

export function keysPreset(name: string): KeysPreset | undefined {
  return KEYS_PRESETS.find((p) => p.name === name);
}
