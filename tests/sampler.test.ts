import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLER_PARAMS, detectPitch, loudnessDb, mapZones, noteFromName, playbackRate, sanitizeZone, uncoveredKeys, zoneFor, type SamplerZone } from '../src/sampler/zones';

const zone = (id: string, root: number, o: Partial<SamplerZone> = {}): SamplerZone => ({ id, assetId: `a_${id}`, name: id, root, lo: 0, hi: 127, velLo: 1, velHi: 127, tune: 0, gain: 0, loudness: -20, ...o });

describe('Sampler: root notes from file names', () => {
  it('reads note names with octaves and accidentals', () => {
    expect(noteFromName('Piano_C4.wav')).toBe(60);
    expect(noteFromName('Bass A#1.flac')).toBe(34);
    expect(noteFromName('strings-Db3')).toBe(49);
    expect(noteFromName('Grand A0 ff.wav')).toBe(21);
    expect(noteFromName('Pad_F♯5')).toBe(78);
    expect(noteFromName('lead C-1')).toBe(0);
    // the last match wins over earlier tokens
    expect(noteFromName('Piano_mf_E2_C4')).toBe(60);
  });

  it('reads bare MIDI numbers and ignores words', () => {
    expect(noteFromName('pad-060.wav')).toBe(60);
    expect(noteFromName('Rhodes 72 soft')).toBe(72);
    expect(noteFromName('kick_dry')).toBeNull();
    expect(noteFromName('pad1 take2')).toBeNull();
  });
});

describe('Sampler: pitch detection', () => {
  const tone = (f: number, sr = 44100, harmonics = 1) => {
    const n = Math.round(0.4 * sr);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) for (let h = 1; h <= harmonics; h++) x[i] = (x[i] as number) + Math.sin((2 * Math.PI * f * h * i) / sr) / h;
    return x;
  };
  it('finds the fundamental of pure and rich tones', () => {
    for (const midi of [33, 45, 57, 60, 69, 84]) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      for (const h of [1, 8]) {
        const p = detectPitch(tone(f, 44100, h), 44100);
        expect(p, `${midi}/${h}`).not.toBeNull();
        expect(Math.abs((p?.midi ?? 0) - midi), `${midi}/${h}`).toBeLessThan(0.1);
      }
    }
  });
  it('gives up on noise', () => {
    let s = 1;
    const x = Float32Array.from({ length: 20000 }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
    const p = detectPitch(x, 44100);
    expect(p === null || p.confidence < 0.7).toBe(true);
  });
  it('measures loudness for layer ordering', () => {
    const a = tone(220);
    const b = a.map((v) => v * 0.25);
    expect(loudnessDb(a, 44100) - loudnessDb(b, 44100)).toBeCloseTo(12.04, 1);
  });
});

describe('Sampler: mapping and extrapolation', () => {
  it('auto mapping splits keys halfway between roots and covers the whole keyboard', () => {
    const m = mapZones({ autoMap: true, params: DEFAULT_SAMPLER_PARAMS, zones: [zone('c4', 60), zone('c3', 48), zone('c5', 72)] });
    const byRoot = (r: number) => m.find((z) => z.root === r);
    expect([byRoot(48)?.keyLo, byRoot(48)?.keyHi]).toEqual([0, 54]);
    expect([byRoot(60)?.keyLo, byRoot(60)?.keyHi]).toEqual([55, 66]);
    expect([byRoot(72)?.keyLo, byRoot(72)?.keyHi]).toEqual([67, 127]);
    expect(uncoveredKeys(m)).toEqual([]);
  });

  it('samples sharing a root become velocity layers, quiet to loud', () => {
    const m = mapZones({ autoMap: true, params: DEFAULT_SAMPLER_PARAMS, zones: [zone('ff', 60, { loudness: -6 }), zone('pp', 60, { loudness: -30 }), zone('mf', 60, { loudness: -15 })] });
    expect(zoneFor(m, 60, 20)?.id).toBe('pp');
    expect(zoneFor(m, 60, 64)?.id).toBe('mf');
    expect(zoneFor(m, 60, 127)?.id).toBe('ff');
    expect(m.map((z) => [z.vLo, z.vHi]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([[1, 42], [43, 85], [86, 127]]);
  });

  it('one sample plays the whole keyboard, pitched from its root', () => {
    const m = mapZones({ autoMap: true, params: DEFAULT_SAMPLER_PARAMS, zones: [zone('only', 57)] });
    expect(zoneFor(m, 21, 100)?.id).toBe('only');
    expect(zoneFor(m, 108, 100)?.id).toBe('only');
    expect(playbackRate({ root: 57, tune: 0 }, 69)).toBeCloseTo(2, 10);
    expect(playbackRate({ root: 57, tune: 0 }, 45)).toBeCloseTo(0.5, 10);
    expect(playbackRate({ root: 57, tune: 50 }, 57, 0, 0)).toBeCloseTo(Math.pow(2, 0.5 / 12), 10);
    expect(playbackRate({ root: 57, tune: 0 }, 57, 2, -2)).toBeCloseTo(1, 10);
  });

  it('manual mapping keeps the set ranges; gaps borrow the nearest zone', () => {
    const m = mapZones({ autoMap: false, params: DEFAULT_SAMPLER_PARAMS, zones: [zone('low', 40, { lo: 36, hi: 47 }), zone('high', 64, { lo: 60, hi: 71 })] });
    expect(zoneFor(m, 40, 100)?.id).toBe('low');
    expect(zoneFor(m, 50, 100)?.id).toBe('low'); // 3 keys from low, 10 from high
    expect(zoneFor(m, 57, 100)?.id).toBe('high');
    expect(zoneFor(m, 100, 100)?.id).toBe('high');
    expect(uncoveredKeys(m)).toContain(50);
    expect(uncoveredKeys(m)).not.toContain(40);
  });

  it('sanitize repairs bad zones and rejects zones without audio', () => {
    expect(sanitizeZone({ name: 'x' })).toBeNull();
    const z = sanitizeZone({ assetId: 'a', root: 300, lo: 90, hi: 10, velLo: 0, tune: 999 });
    expect(z?.root).toBe(127);
    expect([z?.lo, z?.hi]).toEqual([10, 90]);
    expect(z?.velLo).toBe(1);
    expect(z?.tune).toBe(100);
  });
});
