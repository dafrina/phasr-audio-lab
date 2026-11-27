/**
 * MP3 export: float stereo → 16-bit (TPDF dither) → LAME (CBR) with a small
 * ID3v2.3 tag, plus a frame-level inspector used to verify the result.
 * Pure (no DOM), so it runs in the encoder worker and in Node tests.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { MP3_SAMPLE_RATES, type Mp3Bitrate } from './mp3Format';

// the light part (constants, frame inspector) lives in mp3Format so the app can use it without loading LAME
export { MP3_BITRATES, MP3_SAMPLE_RATES, inspectMp3, type Mp3Bitrate, type Mp3Info } from './mp3Format';

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
