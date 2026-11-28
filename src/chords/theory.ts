/**
 * Gucci Slipper-izer — the chord tool's music theory, kept pure (no audio,
 * no React) so live playing, clip playback, export, "Bake to notes" and the
 * tests all share it.
 *
 * Idea: you choose a *vibe* (a curated palette of chord progressions) and a
 * key; every key you press on the keyboard plays a full chord instead of a
 * single note:
 *
 *   white keys C D E F G A B → chords 1–7 of the progression
 *     (C D E F in a row play the progression's main 4-chord loop)
 *   black keys C# D# F# G# A# → a spicier version of the chord to their left
 *   the octave you play in moves the chord up or down
 *
 * Voicings are chosen around a fixed centre pitch, so consecutive chords
 * stay close together (smooth voice leading) without any hidden state —
 * live playing and clip playback always produce identical chords.
 *
 * Auto-play turns one held key into the whole progression in rhythm.
 */

export type ChordPlayMode = 'chord' | 'auto';
export type ChordPattern = 'hold' | 'stabs' | 'offbeat' | 'syncopated' | 'arp';
export type ChordVoicing = 'close' | 'wide';

export interface ChordToolConfig {
  enabled: boolean;
  vibe: string;
  /** index into the vibe's progressions */
  progression: number;
  /** tonic pitch class 0..11 */
  key: number;
  play: ChordPlayMode;
  pattern: ChordPattern;
  /** note division of stabs/arps: 4 = quarters, 8 = eighths, 16 = sixteenths */
  rate: 4 | 8 | 16;
  /** auto-play: bars per chord */
  chordBars: 0.5 | 1 | 2;
  voicing: ChordVoicing;
  /** add the root an octave or two below */
  bass: boolean;
  /** 0…1: roll the chord tones like a strummed/rolled chord */
  strum: number;
}

// ---------------------------------------------------------------------------
// Chord qualities
// ---------------------------------------------------------------------------

export const QUALITIES = {
  maj: { iv: [0, 4, 7], sym: '' },
  min: { iv: [0, 3, 7], sym: 'm' },
  '5': { iv: [0, 7, 12], sym: '5' },
  maj7: { iv: [0, 4, 7, 11], sym: 'maj7' },
  m7: { iv: [0, 3, 7, 10], sym: 'm7' },
  '7': { iv: [0, 4, 7, 10], sym: '7' },
  '6': { iv: [0, 4, 7, 9], sym: '6' },
  m6: { iv: [0, 3, 7, 9], sym: 'm6' },
  '69': { iv: [0, 4, 7, 9, 14], sym: '6/9' },
  maj9: { iv: [0, 4, 7, 11, 14], sym: 'maj9' },
  m9: { iv: [0, 3, 7, 10, 14], sym: 'm9' },
  '9': { iv: [0, 4, 7, 10, 14], sym: '9' },
  '13': { iv: [0, 4, 10, 14, 21], sym: '13' },
  m11: { iv: [0, 3, 7, 10, 14, 17], sym: 'm11' },
  add9: { iv: [0, 4, 7, 14], sym: 'add9' },
  madd9: { iv: [0, 3, 7, 14], sym: 'm(add9)' },
  sus2: { iv: [0, 2, 7], sym: 'sus2' },
  sus4: { iv: [0, 5, 7], sym: 'sus4' },
  '7sus4': { iv: [0, 5, 7, 10], sym: '7sus4' },
  m7b5: { iv: [0, 3, 6, 10], sym: 'm7♭5' },
  dim7: { iv: [0, 3, 6, 9], sym: 'dim7' },
  '7b9': { iv: [0, 4, 7, 10, 13], sym: '7♭9' },
  'maj7#11': { iv: [0, 4, 7, 11, 18], sym: 'maj7♯11' },
} as const satisfies Record<string, { iv: readonly number[]; sym: string }>;

export type Quality = keyof typeof QUALITIES;

/** a chord in a palette: root as semitones above the tonic + quality */
export type PaletteChord = readonly [number, Quality];

export interface Progression {
  name: string;
  /** 7 chords: the first 4 are the loop (keys C D E F), then 3 extras (G A B) */
  chords: readonly [PaletteChord, PaletteChord, PaletteChord, PaletteChord, PaletteChord, PaletteChord, PaletteChord];
}

export interface Vibe {
  id: string;
  name: string;
  /** one-line description for people who don't read chord symbols */
  feel: string;
  minor: boolean;
  defaultKey: number;
  progressions: readonly Progression[];
  /** suggested auto-play pattern */
  pattern: ChordPattern;
}

export const VIBES: readonly Vibe[] = [
  {
    id: 'deephouse',
    name: '90s Deep House',
    feel: 'Organ-style minor 7th/9th stabs — warm, hypnotic, made for offbeat house grooves',
    minor: true,
    defaultKey: 9,
    pattern: 'offbeat',
    progressions: [
      { name: 'Late Night Organ', chords: [[0, 'm9'], [8, 'maj9'], [5, 'm9'], [7, 'm7'], [10, '69'], [3, 'maj7'], [5, 'm11']] },
      { name: 'Two-Chord Vamp', chords: [[0, 'm9'], [5, 'm9'], [0, 'm11'], [10, '9'], [8, 'maj7'], [3, 'maj9'], [7, 'm7']] },
      { name: 'Warehouse Sunrise', chords: [[8, 'maj7'], [10, '69'], [0, 'm9'], [7, 'm7'], [5, 'm9'], [3, 'add9'], [10, '7sus4']] },
    ],
  },
  {
    id: 'jazzy',
    name: 'Jazzy',
    feel: 'Smoky lounge chords: rich 9ths and 13ths that resolve like a jazz standard',
    minor: false,
    defaultKey: 0,
    pattern: 'hold',
    progressions: [
      { name: 'Two-Five-One', chords: [[2, 'm9'], [7, '13'], [0, 'maj9'], [9, '7b9'], [4, 'm7'], [5, 'maj7#11'], [11, 'm7b5']] },
      { name: 'Turnaround', chords: [[0, 'maj7'], [9, '7'], [2, 'm9'], [7, '9'], [4, 'm7'], [5, '69'], [3, 'dim7']] },
      { name: 'Minor Two-Five', chords: [[11, 'm7b5'], [4, '7b9'], [9, 'm9'], [9, 'm6'], [2, 'm9'], [7, '13'], [0, 'maj9']] },
    ],
  },
  {
    id: 'neosoul',
    name: 'Neo-Soul',
    feel: 'Silky, laid-back and a little bittersweet — keys under a late-night R&B vocal',
    minor: false,
    defaultKey: 3,
    pattern: 'hold',
    progressions: [
      { name: 'Velvet', chords: [[5, 'maj9'], [4, 'm7'], [2, 'm9'], [0, 'maj9'], [9, 'm9'], [7, '7sus4'], [10, '9']] },
      { name: 'Sunday Morning', chords: [[0, 'maj9'], [9, 'm9'], [2, 'm9'], [7, '7sus4'], [4, 'm7'], [5, 'maj7#11'], [10, '69']] },
    ],
  },
  {
    id: 'lofi',
    name: 'Lo-fi Chill',
    feel: 'Dreamy study-beat chords — soft, nostalgic, a bit hazy',
    minor: false,
    defaultKey: 5,
    pattern: 'hold',
    progressions: [
      { name: 'Rainy Window', chords: [[0, 'maj7'], [9, 'm9'], [2, 'm7'], [7, '9'], [4, 'm7'], [5, 'maj9'], [10, '9']] },
      { name: 'Tape Loop', chords: [[5, 'maj9'], [7, '6'], [4, 'm7'], [9, 'm9'], [2, 'm9'], [0, 'maj7'], [10, 'maj7']] },
    ],
  },
  {
    id: 'emotional',
    name: 'Emotional Techno',
    feel: 'Big, dark and euphoric minor chords for melodic techno and festival breakdowns',
    minor: true,
    defaultKey: 9,
    pattern: 'stabs',
    progressions: [
      { name: 'Euphoria', chords: [[0, 'madd9'], [8, 'maj7'], [3, 'add9'], [10, 'sus2'], [5, 'm7'], [7, 'm7'], [10, '6']] },
      { name: 'Dark Cathedral', chords: [[0, 'madd9'], [10, 'sus2'], [8, 'maj7'], [7, 'm7'], [5, 'madd9'], [3, 'maj7'], [2, 'm7b5']] },
      { name: 'Into the Void', chords: [[0, '5'], [8, '5'], [3, '5'], [10, '5'], [5, '5'], [7, 'min'], [1, 'maj']] },
    ],
  },
  {
    id: 'pop',
    name: 'Pop Anthem',
    feel: 'Bright, catchy, sing-along chords — the four chords half the radio uses',
    minor: false,
    defaultKey: 7,
    pattern: 'stabs',
    progressions: [
      { name: 'Anthem', chords: [[0, 'add9'], [7, 'maj'], [9, 'm7'], [5, 'add9'], [2, 'm7'], [4, 'min'], [7, 'sus4']] },
      { name: 'Heartbreak', chords: [[9, 'min'], [5, 'maj7'], [0, 'add9'], [7, 'sus4'], [2, 'm7'], [4, 'm7'], [10, 'maj']] },
    ],
  },
  {
    id: 'gospel',
    name: 'Gospel',
    feel: 'Uplifting church chords with passing tension — big, soulful resolutions',
    minor: false,
    defaultKey: 8,
    pattern: 'hold',
    progressions: [
      { name: 'Church', chords: [[0, 'maj9'], [4, '7'], [9, 'm9'], [2, '9'], [5, '69'], [7, '13'], [6, 'dim7']] },
      { name: 'Walk-Up', chords: [[5, 'maj9'], [6, 'dim7'], [7, '13'], [0, 'maj9'], [9, 'm9'], [2, 'm9'], [4, '7']] },
    ],
  },
];

export function vibeById(id: string): Vibe {
  return VIBES.find((v) => v.id === id) ?? (VIBES[0] as Vibe);
}

export function progressionOf(cfg: Pick<ChordToolConfig, 'vibe' | 'progression'>): Progression {
  const v = vibeById(cfg.vibe);
  return v.progressions[Math.min(v.progressions.length - 1, Math.max(0, cfg.progression))] ?? (v.progressions[0] as Progression);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function defaultChordTool(vibeId = 'deephouse'): ChordToolConfig {
  const v = vibeById(vibeId);
  return { enabled: true, vibe: v.id, progression: 0, key: v.defaultKey, play: 'chord', pattern: v.pattern, rate: 8, chordBars: 1, voicing: 'close', bass: true, strum: 0 };
}

const PATTERNS: readonly ChordPattern[] = ['hold', 'stabs', 'offbeat', 'syncopated', 'arp'];

/** Validate untrusted data (project files). Returns null for "no chord tool". */
export function sanitizeChordTool(raw: unknown): ChordToolConfig | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = defaultChordTool(typeof r.vibe === 'string' ? r.vibe : undefined);
  const int = (x: unknown, lo: number, hi: number, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def);
  const v = vibeById(d.vibe);
  return {
    enabled: r.enabled !== false,
    vibe: d.vibe,
    progression: int(r.progression, 0, v.progressions.length - 1, 0),
    key: int(r.key, 0, 11, d.key),
    play: r.play === 'auto' ? 'auto' : 'chord',
    pattern: PATTERNS.includes(r.pattern as ChordPattern) ? (r.pattern as ChordPattern) : d.pattern,
    rate: r.rate === 4 || r.rate === 16 ? r.rate : 8,
    chordBars: r.chordBars === 0.5 || r.chordBars === 2 ? r.chordBars : 1,
    voicing: r.voicing === 'wide' ? 'wide' : 'close',
    bass: r.bass !== false,
    strum: typeof r.strum === 'number' && Number.isFinite(r.strum) ? Math.min(1, Math.max(0, r.strum)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Keys → chords
// ---------------------------------------------------------------------------

const WHITE_SLOT: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const BLACK_SLOT: Record<number, number> = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

/** Which chord a key plays: palette slot (0–6), spice (black key) and octave shift relative to C4. */
export function keyToSlot(pitch: number): { slot: number; spice: boolean; octave: number } {
  const pc = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12) - 5;
  const w = WHITE_SLOT[pc];
  if (w !== undefined) return { slot: w, spice: false, octave };
  return { slot: BLACK_SLOT[pc] ?? 0, spice: true, octave };
}

/** Add colour to a chord (black keys): minor → 11th, maj7 → ♯11, dominant → altered, triads → 6/9. */
export function spiceChord(iv: readonly number[], sym: string): { intervals: number[]; sym: string } {
  const has = (x: number) => iv.includes(x);
  let out: number[];
  let name: string;
  if (has(4) && has(10)) [out, name] = [[0, 4, 10, 13, 20], '7alt']; // ♭9, ♭13
  else if (has(3) && has(6)) [out, name] = [[...iv, 14], `${sym}(9)`];
  else if (has(3)) [out, name] = [[0, 3, 7, 10, 14, 17], 'm11'];
  else if (has(4) && has(11)) [out, name] = [[0, 4, 7, 11, 14, 18], 'maj9♯11'];
  else if (has(4) && has(9)) [out, name] = [[0, 4, 7, 9, 14, 18], '6/9♯11'];
  else if (has(4)) [out, name] = [[0, 4, 7, 9, 14], '6/9'];
  else [out, name] = [[...iv, 14], `${sym}add9`];
  return { intervals: [...new Set(out)].sort((a, b) => a - b), sym: name };
}

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/** major keys that are written with flats */
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1, 6]);

export function noteName(pc: number, cfg: Pick<ChordToolConfig, 'vibe' | 'key'>): string {
  const major = vibeById(cfg.vibe).minor ? (cfg.key + 3) % 12 : cfg.key;
  return (FLAT_MAJORS.has(major) ? FLAT : SHARP)[((pc % 12) + 12) % 12] ?? '?';
}

export function keyName(cfg: Pick<ChordToolConfig, 'vibe' | 'key'>): string {
  return `${noteName(cfg.key, cfg)} ${vibeById(cfg.vibe).minor ? 'minor' : 'major'}`;
}

export interface ResolvedChord {
  /** e.g. "Am9" */
  name: string;
  rootPc: number;
  intervals: number[];
  spice: boolean;
}

export function chordAtSlot(cfg: ChordToolConfig, slot: number, spice = false): ResolvedChord {
  const [deg, q] = progressionOf(cfg).chords[Math.min(6, Math.max(0, slot))] as PaletteChord;
  const base = QUALITIES[q];
  const sp = spice ? spiceChord(base.iv, base.sym) : null;
  const intervals = sp ? sp.intervals : [...base.iv];
  const rootPc = (cfg.key + deg) % 12;
  const root = noteName(rootPc, cfg);
  return { name: `${root}${sp ? sp.sym : base.sym}`, rootPc, intervals, spice };
}

export function chordForKey(cfg: ChordToolConfig, pitch: number): ResolvedChord & { octave: number; slot: number } {
  const { slot, spice, octave } = keyToSlot(pitch);
  return { ...chordAtSlot(cfg, slot, spice), octave, slot };
}

/** Short label for a piano-roll row: the chord that key plays. */
export function chordLabel(cfg: ChordToolConfig, pitch: number): string {
  return chordForKey(cfg, pitch).name;
}

// ---------------------------------------------------------------------------
// Voicing
// ---------------------------------------------------------------------------

/** centre pitch the voicings gravitate to (E4) */
const CENTER = 64;
const MAX_UPPER = 5;

/**
 * Concrete MIDI notes for a chord. The upper structure is the inversion and
 * octave whose average pitch is closest to the centre (so changes between
 * chords move as little as possible); the bass adds the root low.
 */
export function voiceChord(chord: Pick<ResolvedChord, 'rootPc' | 'intervals'>, cfg: Pick<ChordToolConfig, 'voicing' | 'bass'>, octaveShift = 0): { bass: number | null; upper: number[] } {
  // (the octave is the played key's: the keyboard's octave selector moves it)
  const shift = Math.max(-3, Math.min(3, octaveShift)) * 12;
  const power = chord.intervals.length === 3 && chord.intervals[1] === 7;
  // with a bass note, rich chords are voiced rootless (the bass carries the root)
  let tones = chord.intervals.map((i) => (chord.rootPc + i) % 12);
  if (cfg.bass && chord.intervals.length >= 4 && !power) tones = tones.slice(1);
  let pcs = [...new Set(tones)];
  if (pcs.length > MAX_UPPER) pcs = pcs.slice(0, MAX_UPPER);
  const center = CENTER + shift;
  let best: number[] = [];
  let bestScore = Infinity;
  for (let r = 0; r < pcs.length; r++) {
    // stack the rotated tones upwards
    const stack: number[] = [];
    for (let j = 0; j < pcs.length; j++) {
      const pc = pcs[(r + j) % pcs.length] as number;
      let n = j === 0 ? pc : (stack[j - 1] as number) + ((((pc - (stack[j - 1] as number)) % 12) + 12) % 12 || 12);
      if (j === 0) n = pc;
      stack.push(n);
    }
    const mean = stack.reduce((a, b) => a + b, 0) / stack.length;
    const oct = Math.round((center - mean) / 12);
    const placed = stack.map((n) => n + oct * 12);
    const span = (placed[placed.length - 1] as number) - (placed[0] as number);
    const score = Math.abs(placed.reduce((a, b) => a + b, 0) / placed.length - center) + 0.15 * span;
    if (score < bestScore) {
      bestScore = score;
      best = placed;
    }
  }
  let upper = best;
  if (cfg.voicing === 'wide' && upper.length >= 3) {
    // drop-2: the second voice from the top goes down an octave (open, spacious)
    const i = upper.length - 2;
    upper = [...upper.slice(0, i), ...upper.slice(i + 1), (upper[i] as number) - 12].sort((a, b) => a - b);
  }
  if (power) upper = best; // power chords stay tight
  let bass: number | null = null;
  if (cfg.bass) {
    const low = 40 + shift; // around E2
    bass = low + ((((chord.rootPc - low) % 12) + 12) % 12);
    while (bass >= (upper[0] ?? 128) - 4) bass -= 12;
  }
  const clamp = (n: number) => Math.min(127, Math.max(0, n));
  return { bass: bass === null ? null : clamp(bass), upper: upper.map(clamp) };
}

// ---------------------------------------------------------------------------
// Note expansion (clips, export, bake) — all in ticks
// ---------------------------------------------------------------------------

export interface NoteLike {
  pitch: number;
  start: number;
  length: number;
  /** 1..127 */
  velocity: number;
}

const MIN_LEN = 20;

function chordNotes(cfg: ChordToolConfig, chord: ResolvedChord, octaveShift: number, start: number, length: number, velocity: number, ppq: number): NoteLike[] {
  const { bass, upper } = voiceChord(chord, cfg, octaveShift);
  const pitches = bass === null ? upper : [bass, ...upper];
  // strum: up to a 1/32 note between the lowest and highest voice
  const step = pitches.length > 1 ? (cfg.strum * (ppq / 8)) / (pitches.length - 1) : 0;
  return pitches.map((pitch, i) => {
    const off = Math.round(i * step);
    return { pitch, start: start + off, length: Math.max(MIN_LEN, length - off), velocity: pitch === bass ? Math.min(127, velocity + 6) : velocity };
  });
}

/** syncopated house rhythm: positions in 16ths within a bar of 4/4 */
const SYNC_16THS = [0, 3, 6, 10, 12];

/**
 * Turn one played note into what the chord tool plays.
 * `align` = absolute tick the note's start is relative to (clip start), so
 * patterns and chord changes lock to the song's bar grid.
 */
export function expandNote(cfg: ChordToolConfig, note: NoteLike, barTicks: number, ppq = 960, align = 0): NoteLike[] {
  const chord = chordForKey(cfg, note.pitch);
  const end = note.start + note.length;
  if (cfg.play === 'chord') return chordNotes(cfg, chord, chord.octave, note.start, note.length, note.velocity, ppq);
  // auto-play: the progression from this chord, in rhythm
  const chordLen = Math.max(ppq, Math.round(barTicks * cfg.chordBars));
  const absStart = note.start + align;
  const gridStart = Math.floor(absStart / chordLen) * chordLen;
  const loopLen = chord.slot < 4 ? 4 : 1;
  const out: NoteLike[] = [];
  const clip = (n: NoteLike): NoteLike | null => {
    const s = Math.max(n.start, note.start);
    const e = Math.min(n.start + n.length, end);
    return e - s >= MIN_LEN / 2 ? { ...n, start: s, length: Math.max(MIN_LEN, e - s) } : null;
  };
  const push = (n: NoteLike | null) => {
    if (n) out.push(n);
  };
  const step = Math.round((ppq * 4) / cfg.rate);
  for (let segAbs = gridStart, k = 0; segAbs < end + align; segAbs += chordLen, k++) {
    const segStart = segAbs - align;
    const segEnd = segStart + chordLen;
    if (segEnd <= note.start) continue;
    const slot = loopLen === 4 ? (chord.slot + k) % 4 : chord.slot;
    const c = chordAtSlot(cfg, slot, chord.spice);
    const { bass, upper } = voiceChord(c, cfg, chord.octave);
    const hits: { at: number; len: number }[] = [];
    switch (cfg.pattern) {
      case 'hold':
        hits.push({ at: segStart, len: chordLen });
        break;
      case 'stabs':
        for (let t = 0; t < chordLen; t += step) hits.push({ at: segStart + t, len: Math.round(step * 0.55) });
        break;
      case 'offbeat':
        for (let t = ppq / 2; t < chordLen; t += ppq) hits.push({ at: segStart + t, len: Math.round(ppq * 0.3) });
        break;
      case 'syncopated': {
        const s16 = ppq / 4;
        for (let bar = 0; bar < chordLen; bar += barTicks) for (const p of SYNC_16THS) if (bar + p * s16 < chordLen) hits.push({ at: segStart + bar + p * s16, len: Math.round(s16 * 1.6) });
        break;
      }
      case 'arp': {
        const seq = [...upper, ...upper.slice(1, -1).reverse()];
        let i = 0;
        for (let t = 0; t < chordLen; t += step, i++) {
          const pitch = seq[i % Math.max(1, seq.length)] as number;
          push(clip({ pitch, start: segStart + t, length: Math.round(step * 0.9), velocity: note.velocity }));
        }
        break;
      }
    }
    for (const h of hits) for (const n of chordNotes(cfg, c, chord.octave, h.at, h.len, note.velocity, ppq)) if (n.pitch !== bass) push(clip(n));
    // the bass holds each chord (plays on the downbeat of the chord)
    if (bass !== null) push(clip({ pitch: bass, start: segStart, length: cfg.pattern === 'hold' ? chordLen : Math.round(chordLen * 0.9), velocity: Math.min(127, note.velocity + 6) }));
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
