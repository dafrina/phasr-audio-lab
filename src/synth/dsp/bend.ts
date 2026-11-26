/**
 * Automation key for an instrument's pitch bend: a lane of −1…+1, the same
 * range as the pitch wheel (scaled by the instrument's bend range). Not a
 * patch parameter: each instrument routes it to its pitch-bend input.
 * Dependency-free so the worklets can import it.
 */
export const PITCH_BEND_KEY = 'pitchBend';
