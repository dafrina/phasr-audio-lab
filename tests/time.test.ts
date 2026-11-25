import { describe, expect, it } from 'vitest';
import {
  PPQ,
  bbtToTicks,
  formatBBT,
  midiNoteToFrequency,
  noteFrequencyWithOffsets,
  quantize,
  quantizeFloor,
  quantizeStrength,
  samplesToTicks,
  secondsToTicks,
  snapToTicks,
  ticksPerBar,
  ticksToBBT,
  ticksToSamples,
  ticksToSeconds,
} from '../src/core/time';

const FOUR4 = { numerator: 4, denominator: 4 };

describe('tick conversion', () => {
  it('uses 960 PPQ', () => {
    expect(PPQ).toBe(960);
  });
  it('converts ticks to seconds at 120 BPM', () => {
    expect(ticksToSeconds(PPQ, 120)).toBeCloseTo(0.5, 12);
    expect(ticksToSeconds(PPQ * 4, 120)).toBeCloseTo(2, 12);
  });
  it('round-trips seconds ↔ ticks', () => {
    for (const bpm of [60, 97.5, 120, 174]) {
      for (const t of [0, 1, 479, 960, 123456]) {
        expect(secondsToTicks(ticksToSeconds(t, bpm), bpm)).toBeCloseTo(t, 6);
      }
    }
  });
  it('converts ticks to samples', () => {
    expect(ticksToSamples(PPQ, 120, 48000)).toBe(24000);
    expect(samplesToTicks(24000, 120, 48000)).toBeCloseTo(960, 9);
  });
  it('computes bar lengths for different time signatures', () => {
    expect(ticksPerBar(FOUR4)).toBe(3840);
    expect(ticksPerBar({ numerator: 3, denominator: 4 })).toBe(2880);
    expect(ticksPerBar({ numerator: 6, denominator: 8 })).toBe(2880);
    expect(ticksPerBar({ numerator: 7, denominator: 8 })).toBe(3360);
  });
  it('converts to bars/beats/ticks', () => {
    expect(ticksToBBT(0, FOUR4)).toEqual({ bar: 1, beat: 1, tick: 0 });
    expect(ticksToBBT(960 * 5 + 10, FOUR4)).toEqual({ bar: 2, beat: 2, tick: 10 });
    expect(ticksToBBT(480 * 7, { numerator: 6, denominator: 8 })).toEqual({ bar: 2, beat: 2, tick: 0 });
    expect(bbtToTicks({ bar: 3, beat: 4, tick: 100 }, FOUR4)).toBe(3840 * 2 + 960 * 3 + 100);
    expect(formatBBT(960 * 5 + 10, FOUR4)).toBe('2.2.010');
  });
});

describe('quantization', () => {
  it('snaps to the nearest grid line', () => {
    expect(quantize(470, 480)).toBe(480);
    expect(quantize(230, 480)).toBe(0);
    expect(quantize(250, 480)).toBe(480);
    expect(quantize(1234.4, 0)).toBe(1234);
  });
  it('floors to the grid', () => {
    expect(quantizeFloor(959, 480)).toBe(480);
    expect(quantizeFloor(960, 480)).toBe(960);
  });
  it('supports partial strength', () => {
    expect(quantizeStrength(400, 480, 0.5)).toBe(440);
    expect(quantizeStrength(400, 480, 0)).toBe(400);
    expect(quantizeStrength(400, 480, 1)).toBe(480);
  });
  it('maps snap names to ticks including triplets', () => {
    expect(snapToTicks('1/16', FOUR4)).toBe(240);
    expect(snapToTicks('1/8T', FOUR4)).toBe(320);
    expect(snapToTicks('bar', FOUR4)).toBe(3840);
    expect(snapToTicks('off', FOUR4)).toBe(0);
  });
});

describe('note to frequency', () => {
  it('follows 440 × 2^((n − 69)/12)', () => {
    expect(midiNoteToFrequency(69)).toBe(440);
    expect(midiNoteToFrequency(81)).toBeCloseTo(880, 9);
    expect(midiNoteToFrequency(60)).toBeCloseTo(261.6256, 3);
    expect(midiNoteToFrequency(0)).toBeCloseTo(8.1758, 3);
  });
  it('applies coarse and fine offsets', () => {
    expect(noteFrequencyWithOffsets(69, 12, 0)).toBeCloseTo(880, 9);
    expect(noteFrequencyWithOffsets(69, 0, 100)).toBeCloseTo(midiNoteToFrequency(70), 9);
    expect(noteFrequencyWithOffsets(69, -1, 50)).toBeCloseTo(440 * Math.pow(2, -0.5 / 12), 9);
  });
});
