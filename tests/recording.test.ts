import { describe, expect, it } from 'vitest';
import { assembleChunks, estimateLatency, LIVE_PEAK_BUCKET, LivePeaks, placeRecordedClip } from '../src/audio/recordingMath';
import { decodeWav, encodeWav } from '../src/audio/wav';

describe('WAV encoding', () => {
  const sine = (n: number, f: number, sr: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

  it('writes a valid float32 stereo file that round-trips exactly', () => {
    const l = sine(1000, 440, 48000);
    const r = sine(1000, 660, 48000, 0.25);
    const buf = encodeWav([l, r], 48000, { format: 'float32' });
    expect(buf.byteLength).toBe(44 + 1000 * 2 * 4);
    const d = decodeWav(buf);
    expect(d.sampleRate).toBe(48000);
    expect(d.format).toBe('float32');
    expect(d.channels[0]).toEqual(l);
    expect(d.channels[1]).toEqual(r);
  });

  it('writes 16-bit PCM with dither within 1.5 LSB and correct header fields', () => {
    const l = sine(4410, 1000, 44100, 0.9);
    const buf = encodeWav([l, l], 44100, { format: 'pcm16' });
    const v = new DataView(buf);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(4410 * 4);
    const d = decodeWav(buf);
    let maxErr = 0;
    for (let i = 0; i < l.length; i++) maxErr = Math.max(maxErr, Math.abs((d.channels[0]?.[i] ?? 0) - (l[i] as number)));
    expect(maxErr).toBeLessThan(1.5 / 32768 + 1e-6);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const d = decodeWav(encodeWav([Float32Array.from([2, -2, 0])], 8000, { format: 'pcm16', dither: false }));
    expect(d.channels[0]?.[0]).toBeCloseTo(32767 / 32768, 6);
    expect(d.channels[0]?.[1]).toBe(-1);
  });
});

describe('recording assembly', () => {
  it('concatenates chunks including a partial last chunk', () => {
    const mk = (v: number, n: number, frames = n) => ({ l: new Float32Array(n).fill(v), r: new Float32Array(n).fill(-v), frames });
    const [l, r] = assembleChunks([mk(0.1, 4), mk(0.2, 4), mk(0.3, 4, 2)]);
    expect(l.length).toBe(10);
    expect(Array.from(l).map((x) => +x.toFixed(1))).toEqual([0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.3, 0.3]);
    expect(r[9]).toBeCloseTo(-0.3, 6);
  });

  it('accumulates live peaks per bucket across chunk boundaries', () => {
    const p = new LivePeaks();
    const a = new Float32Array(LIVE_PEAK_BUCKET * 1.5).fill(0.25);
    a[10] = 0.9;
    p.push(a, a, a.length);
    expect(p.max).toHaveLength(1);
    expect(p.max[0]).toBeCloseTo(0.9, 6);
    const b = new Float32Array(LIVE_PEAK_BUCKET / 2).fill(-0.5);
    p.push(b, b, b.length);
    expect(p.min).toHaveLength(2);
    expect(p.min[1]).toBe(-0.5);
    expect(p.frames).toBe(LIVE_PEAK_BUCKET * 2);
  });
});

describe('latency compensation', () => {
  it('trims the latency from the start of the recording non-destructively', () => {
    const c = placeRecordedClip(3840, 4, 0.05, 120);
    expect(c.start).toBe(3840);
    expect(c.sourceOffset).toBeCloseTo(0.05, 9);
    expect(c.length).toBe(Math.floor((3.95 * 120 * 960) / 60));
  });

  it('never trims more than the recording and handles zero latency', () => {
    expect(placeRecordedClip(0, 0.02, 1, 120).sourceOffset).toBeCloseTo(0.01, 9);
    expect(placeRecordedClip(0, 2, 0, 120)).toEqual({ start: 0, length: 3840, sourceOffset: 0 });
  });

  it('sums latency parts and ignores missing/invalid values', () => {
    expect(estimateLatency({ baseLatency: 0.01, outputLatency: 0.02, inputLatency: 0.005, manualOffsetMs: 5 })).toBeCloseTo(0.04, 9);
    expect(estimateLatency({})).toBe(0);
    expect(estimateLatency({ manualOffsetMs: -100 })).toBe(0);
    expect(estimateLatency({ outputLatency: Number.NaN })).toBe(0);
  });
});
