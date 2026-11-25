import { describe, expect, it } from 'vitest';
import { encodeMp3, id3Tag, inspectMp3, MP3_BITRATES } from '../src/audio/mp3';

function tone(seconds: number, sr: number): [Float32Array, Float32Array] {
  const n = Math.round(seconds * sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    r[i] = 0.5 * Math.sin((2 * Math.PI * 660 * i) / sr);
  }
  return [l, r];
}

describe('MP3 export', () => {
  it('encodes well-formed MPEG-1 Layer III stereo at the chosen bitrate and length', () => {
    for (const sr of [44100, 48000]) {
      const [l, r] = tone(2, sr);
      let lastProgress = 0;
      const bytes = encodeMp3(l, r, { sampleRate: sr, kbps: 192, title: 'Tëst ♫ Song', onProgress: (f) => (lastProgress = f) });
      const info = inspectMp3(bytes);
      expect(info.wellFormed).toBe(true);
      expect(info.hasId3).toBe(true);
      expect(info.sampleRate).toBe(sr);
      expect(info.channels).toBe(2);
      expect(info.kbps).toBe(192);
      // encoder delay/padding adds at most a couple of frames
      expect(info.durationSec).toBeGreaterThanOrEqual(2);
      expect(info.durationSec).toBeLessThan(2 + (3 * 1152) / sr);
      expect(lastProgress).toBe(1);
      // CBR size ≈ bitrate × duration
      expect(bytes.length).toBeGreaterThan(0.9 * (192000 / 8) * 2);
      expect(bytes.length).toBeLessThan(1.1 * (192000 / 8) * 2.2);
    }
  });

  it('higher bitrates make bigger files', () => {
    const [l, r] = tone(1, 44100);
    const sizes = MP3_BITRATES.map((kbps) => encodeMp3(l, r, { sampleRate: 44100, kbps }).length);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('rejects sample rates MP3 cannot carry', () => {
    const [l, r] = tone(0.1, 96000);
    expect(() => encodeMp3(l, r, { sampleRate: 96000, kbps: 320 })).toThrow(/44\.1/);
  });

  it('writes a valid ID3v2.3 title tag', () => {
    const tag = id3Tag('My Song');
    expect(String.fromCharCode(...tag.slice(0, 3))).toBe('ID3');
    expect(tag[3]).toBe(3);
    const size = ((tag[6] as number) << 21) | ((tag[7] as number) << 14) | ((tag[8] as number) << 7) | (tag[9] as number);
    expect(size).toBe(tag.length - 10);
    expect(String.fromCharCode(...tag.slice(10, 14))).toBe('TIT2');
  });

  it('flags corrupted files', () => {
    const [l, r] = tone(0.5, 44100);
    const bytes = encodeMp3(l, r, { sampleRate: 44100, kbps: 128 });
    const broken = bytes.slice(0, bytes.length - 100);
    expect(inspectMp3(broken).wellFormed).toBe(false);
  });
});
