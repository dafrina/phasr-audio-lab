/**
 * RIFF/WAVE encoding and decoding (pure, no Web Audio).
 * Recordings are stored as 32-bit float WAV (lossless); export uses 16-bit PCM
 * with TPDF dither.
 */

export type WavFormat = 'pcm16' | 'float32';

function writeStr(v: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
}

export interface EncodeOptions {
  format: WavFormat;
  /** Add triangular dither before 16-bit quantization (default true for pcm16) */
  dither?: boolean;
  /** Seed for the dither noise, so output is reproducible */
  seed?: number;
}

export function encodeWav(channels: Float32Array[], sampleRate: number, opts: EncodeOptions): ArrayBuffer {
  const nch = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = opts.format === 'pcm16' ? 2 : 4;
  const blockAlign = nch * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.format === 'pcm16' ? 1 : 3, true); // 1 = PCM, 3 = IEEE float
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bytesPerSample * 8, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  if (opts.format === 'float32') {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        v.setFloat32(off, channels[c]?.[i] ?? 0, true);
        off += 4;
      }
    }
  } else {
    const dither = opts.dither !== false;
    let s = (opts.seed ?? 0x2545f491) | 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) / 4294967296);
    };
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        let x = (channels[c]?.[i] ?? 0) * 32768;
        if (dither) x += rnd() - rnd(); // TPDF, ±1 LSB
        const q = Math.max(-32768, Math.min(32767, Math.round(x)));
        v.setInt16(off, q, true);
        off += 2;
      }
    }
  }
  return buf;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  format: WavFormat;
}

/** Minimal WAV parser (PCM16 / float32) used by tests and archive import checks. */
export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let fmt = 0;
  let nch = 0;
  let sr = 0;
  let bits = 0;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = v.getUint16(off + 8, true);
      nch = v.getUint16(off + 10, true);
      sr = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === 'data') {
      const bps = bits / 8;
      const frames = Math.floor(size / (bps * nch));
      const channels = Array.from({ length: nch }, () => new Float32Array(frames));
      let p = off + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < nch; c++) {
          const ch = channels[c] as Float32Array;
          ch[i] = fmt === 3 ? v.getFloat32(p, true) : v.getInt16(p, true) / 32768;
          p += bps;
        }
      }
      return { sampleRate: sr, channels, format: fmt === 3 ? 'float32' : 'pcm16' };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
