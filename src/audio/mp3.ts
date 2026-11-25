/**
 * MP3 export: float stereo → 16-bit (TPDF dither) → LAME (CBR) with a small
 * ID3v2.3 tag, plus a frame-level inspector used to verify the result.
 * Pure (no DOM), so it runs in the encoder worker and in Node tests.
 */
import { Mp3Encoder } from '@breezystack/lamejs';

export const MP3_BITRATES = [128, 192, 256, 320] as const;
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];
/** MPEG-1 Layer III sample rates */
export const MP3_SAMPLE_RATES = [32000, 44100, 48000] as const;

const CHUNK = 1152 * 16;

/** Minimal ID3v2.3 tag with title and encoder text frames. */
export function id3Tag(title: string, software = 'PHASR Audio Lab'): Uint8Array {
  const frame = (id: string, text: string): Uint8Array => {
    // encoding 1 = UTF-16 with BOM (handles any title)
    const body: number[] = [1, 0xff, 0xfe];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      body.push(c & 0xff, c >> 8);
    }
    const out = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    const n = body.length;
    out[4] = (n >>> 24) & 0xff;
    out[5] = (n >>> 16) & 0xff;
    out[6] = (n >>> 8) & 0xff;
    out[7] = n & 0xff;
    out.set(body, 10);
    return out;
  };
  const frames = [frame('TIT2', title.slice(0, 200)), frame('TSSE', software)];
  const size = frames.reduce((a, f) => a + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0], 0); // "ID3" v2.3, no flags
  // synch-safe size
  tag[6] = (size >>> 21) & 0x7f;
  tag[7] = (size >>> 14) & 0x7f;
  tag[8] = (size >>> 7) & 0x7f;
  tag[9] = size & 0x7f;
  let o = 10;
  for (const f of frames) {
    tag.set(f, o);
    o += f.length;
  }
  return tag;
}

/** float [-1, 1] → int16 with triangular dither (deterministic seed) */
function toInt16(src: Float32Array, from: number, n: number, out: Int16Array, seed: { s: number }): void {
  let s = seed.s;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    const r1 = (s >>> 0) / 4294967296;
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    const r2 = (s >>> 0) / 4294967296;
    const v = Math.round((src[from + i] as number) * 32767 + (r1 - r2));
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  seed.s = s;
}

export interface Mp3Options {
  sampleRate: number;
  kbps: Mp3Bitrate;
  title?: string;
  onProgress?: (fraction: number) => void;
}

export function encodeMp3(left: Float32Array, right: Float32Array, opts: Mp3Options): Uint8Array {
  if (!(MP3_SAMPLE_RATES as readonly number[]).includes(opts.sampleRate)) throw new Error(`MP3 supports 32, 44.1 and 48 kHz (got ${opts.sampleRate} Hz).`);
  const enc = new Mp3Encoder(2, opts.sampleRate, opts.kbps);
  const parts: Uint8Array[] = [id3Tag(opts.title ?? 'Untitled')];
  const l16 = new Int16Array(CHUNK);
  const r16 = new Int16Array(CHUNK);
  const seedL = { s: 0x1234 };
  const seedR = { s: 0x5678 };
  const n = left.length;
  for (let i = 0; i < n; i += CHUNK) {
    const len = Math.min(CHUNK, n - i);
    toInt16(left, i, len, l16, seedL);
    toInt16(right, i, len, r16, seedR);
    const out = enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
    if (out.length) parts.push(out.slice());
    opts.onProgress?.((i + len) / n);
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail.slice());
  const total = parts.reduce((a, p) => a + p.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    file.set(p, o);
    o += p.length;
  }
  return file;
}

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
