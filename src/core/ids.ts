/** Short unique IDs for project entities. Uses crypto.randomUUID where available. */
export function createId(prefix = ''): string {
  const c = globalThis.crypto;
  const raw =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix ? `${prefix}_${raw}` : raw;
}

let noteIdCounter = 1;
/**
 * Monotonic integer IDs for scheduled note instances. Each note-on sent to a
 * synth carries one, and the matching note-off releases exactly that voice,
 * so overlapping notes of the same pitch never cut each other off.
 */
export function nextNoteInstanceId(): number {
  noteIdCounter = (noteIdCounter + 1) % 0x3fffffff;
  return noteIdCounter;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 1e-10 ? -200 : 20 * Math.log10(gain);
}
