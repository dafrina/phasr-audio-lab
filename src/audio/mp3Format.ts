/**
 * MP3 constants and a frame-level inspector (used to verify an encoded file).
 * Kept apart from the encoder (mp3.ts) so the app can use these without
 * loading LAME, which only comes in when an MP3 is actually exported.
 */

export const MP3_BITRATES = [128, 192, 256, 320] as const;
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];
/** MPEG-1 Layer III sample rates */
export const MP3_SAMPLE_RATES = [32000, 44100, 48000] as const;

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const RATE_V1 = [44100, 48000, 32000, 0];

export interface Mp3Info {
  hasId3: boolean;
  frames: number;
  sampleRate: number;
  /** most common bitrate in kbps */
  kbps: number;
  channels: number;
  durationSec: number;
  /** every frame header parsed and the frames tile the file exactly */
  wellFormed: boolean;
}

/** Walk the MPEG-1 Layer III frames of a file (after an optional ID3v2 tag). */
export function inspectMp3(bytes: Uint8Array): Mp3Info {
  let o = 0;
  let hasId3 = false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    hasId3 = true;
    o = 10 + (((bytes[6] as number) << 21) | ((bytes[7] as number) << 14) | ((bytes[8] as number) << 7) | (bytes[9] as number));
  }
  let frames = 0;
  let sampleRate = 0;
  let channels = 0;
  let wellFormed = true;
  const rates = new Map<number, number>();
  while (o + 4 <= bytes.length) {
    const b1 = bytes[o + 1] as number;
    const b2 = bytes[o + 2] as number;
    const b3 = bytes[o + 3] as number;
    // sync (11 bits), MPEG-1 (11), Layer III (01)
    if (bytes[o] !== 0xff || (b1 & 0xfe) !== 0xfa) {
      wellFormed = false;
      break;
    }
    const kbps = BITRATE_V1_L3[b2 >> 4] ?? 0;
    const sr = RATE_V1[(b2 >> 2) & 3] ?? 0;
    if (!kbps || !sr) {
      wellFormed = false;
      break;
    }
    const pad = (b2 >> 1) & 1;
    const len = Math.floor((144 * kbps * 1000) / sr) + pad;
    sampleRate = sr;
    channels = b3 >> 6 === 3 ? 1 : 2;
    rates.set(kbps, (rates.get(kbps) ?? 0) + 1);
    frames++;
    o += len;
  }
  if (o !== bytes.length) wellFormed = false;
  let kbps = 0;
  let best = -1;
  for (const [k, c] of rates) if (c > best) [kbps, best] = [k, c];
  return { hasId3, frames, sampleRate, kbps, channels, durationSec: sampleRate ? (frames * 1152) / sampleRate : 0, wellFormed };
}
