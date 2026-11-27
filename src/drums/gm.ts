/**
 * General MIDI percussion (channel 10) and how a Drum Rack kit maps onto it
 * in MIDI files (pure).
 *
 * The pads sit on notes 36–51 with the GM sounds on their GM keys (kick 36,
 * closed hat 42, crash 49 …, see kit.ts). A pad whose sound GM keeps
 * elsewhere — the cowbell on 51, say, where GM has the ride — is written to a
 * file on its own GM key (56) and read back from it, so a file plays the right
 * sounds in other software and a GM file plays the right pads here.
 *
 * Export: a pad on a key of its own kind keeps it; every other pad takes the
 * first free key of its kind (`ROLE_KEYS`), so no two pads share a key while
 * keys last and a file reads back exactly. Sample pads have no known kind and
 * keep their key. Import inverts that; a key no pad writes goes to the pad of
 * the same kind (or the next best, `FALLBACK`) whose key is closest — a high
 * tom to the highest tom. A key nothing in the kit resembles is kept as it is.
 */
import type { DrumKit, DrumPad } from '../project/types';
import { DRUM_BASE_NOTE, DRUM_PADS } from './kit';

/** GM Level 1 percussion keys 35–81, plus the Level 2 / GS keys 27–34 and 82–87 */
export const GM_DRUM_NAMES: Readonly<Record<number, string>> = {
  27: 'High Q', 28: 'Slap', 29: 'Scratch Push', 30: 'Scratch Pull', 31: 'Sticks', 32: 'Square Click', 33: 'Metronome Click', 34: 'Metronome Bell',
  35: 'Acoustic Bass Drum', 36: 'Bass Drum 1', 37: 'Side Stick', 38: 'Acoustic Snare', 39: 'Hand Clap', 40: 'Electric Snare',
  41: 'Low Floor Tom', 42: 'Closed Hi-Hat', 43: 'High Floor Tom', 44: 'Pedal Hi-Hat', 45: 'Low Tom', 46: 'Open Hi-Hat',
  47: 'Low-Mid Tom', 48: 'Hi-Mid Tom', 49: 'Crash Cymbal 1', 50: 'High Tom', 51: 'Ride Cymbal 1', 52: 'Chinese Cymbal',
  53: 'Ride Bell', 54: 'Tambourine', 55: 'Splash Cymbal', 56: 'Cowbell', 57: 'Crash Cymbal 2', 58: 'Vibraslap',
  59: 'Ride Cymbal 2', 60: 'Hi Bongo', 61: 'Low Bongo', 62: 'Mute Hi Conga', 63: 'Open Hi Conga', 64: 'Low Conga',
  65: 'High Timbale', 66: 'Low Timbale', 67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
  71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro', 75: 'Claves', 76: 'Hi Wood Block',
  77: 'Low Wood Block', 78: 'Mute Cuica', 79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle',
  82: 'Shaker', 83: 'Jingle Bell', 84: 'Belltree', 85: 'Castanets', 86: 'Mute Surdo', 87: 'Open Surdo',
};

/** what kind of sound a key / pad is (the Drum Rack voices, with ride and scratch split off) */
type Role = 'kick' | 'rim' | 'snare' | 'clap' | 'tom' | 'hatClosed' | 'hatOpen' | 'crash' | 'ride' | 'cowbell' | 'shaker' | 'perc' | 'zap' | 'scratch';

/** the GM keys of each kind, most typical first */
const ROLE_KEYS: Record<Role, number[]> = {
  kick: [36, 35],
  rim: [37, 31],
  snare: [38, 40],
  clap: [39],
  tom: [41, 43, 45, 47, 48, 50],
  hatClosed: [42, 44],
  hatOpen: [46],
  crash: [49, 57, 55, 52],
  ride: [51, 59, 53],
  cowbell: [56],
  shaker: [70, 69, 82],
  perc: [60, 61, 62, 63, 64, 76, 77],
  zap: [27],
  scratch: [29, 30],
};

/** the kind of every GM key that has one (keys only read on import are added here) */
const KEY_ROLE: Record<number, Role> = { 28: 'perc', 54: 'shaker', 58: 'perc', 73: 'perc', 74: 'perc', 75: 'rim', 78: 'perc', 79: 'perc', 80: 'perc', 81: 'perc', 83: 'shaker', 85: 'rim', 86: 'tom', 87: 'tom' };
for (let n = 65; n <= 68; n++) KEY_ROLE[n] = 'perc';
for (const [role, keys] of Object.entries(ROLE_KEYS)) for (const k of keys) KEY_ROLE[k] = role as Role;

/** a key's kind is missing from the kit: the next best */
const FALLBACK: Partial<Record<Role, Role>> = { ride: 'crash', crash: 'ride', scratch: 'zap', zap: 'scratch', hatOpen: 'hatClosed' };

function padRole(p: DrumPad | undefined): Role | null {
  if (p?.source.kind !== 'synth') return null;
  const { voice, model } = p.source;
  // the styles that are a different instrument (DRUM_MODELS): House crash = ride, Hip-Hop zap = vinyl scratch
  if (voice === 'crash' && model === 1) return 'ride';
  if (voice === 'zap' && model === 3) return 'scratch';
  return voice;
}

/** The GM key each pad is written to in a MIDI file (index = pad). */
export function kitGmNotes(kit: DrumKit): number[] {
  const out: (number | null)[] = [];
  const taken = new Set<number>();
  for (let i = 0; i < DRUM_PADS; i++) {
    const key = DRUM_BASE_NOTE + i;
    const role = padRole(kit.pads[i]);
    const own = role === null || KEY_ROLE[key] === role;
    out.push(own ? key : null);
    if (own) taken.add(key);
  }
  return out.map((key, i) => {
    if (key !== null) return key;
    const keys = ROLE_KEYS[padRole(kit.pads[i]) as Role];
    const k = keys.find((x) => !taken.has(x)) ?? (keys[0] as number);
    taken.add(k);
    return k;
  });
}

/** The pad note a GM key plays in this kit (`gm` = kitGmNotes(kit), pass it when mapping many notes). */
export function padNoteForGm(kit: DrumKit, key: number, gm: readonly number[] = kitGmNotes(kit)): number {
  const exact = gm.indexOf(key);
  if (exact >= 0) return DRUM_BASE_NOTE + exact;
  const role = KEY_ROLE[key];
  for (const r of role ? [role, FALLBACK[role]] : []) {
    let best = -1;
    for (let i = 0; i < DRUM_PADS; i++) {
      if (padRole(kit.pads[i]) !== r) continue;
      if (best < 0 || Math.abs((gm[i] as number) - key) < Math.abs((gm[best] as number) - key)) best = i;
    }
    if (best >= 0) return DRUM_BASE_NOTE + best;
  }
  return key;
}

/** Pad note → the GM key written to a file (notes that aren't pads are kept). */
export function gmNoteForPad(gm: readonly number[], note: number): number {
  const i = note - DRUM_BASE_NOTE;
  return i >= 0 && i < DRUM_PADS ? (gm[i] as number) : note;
}
