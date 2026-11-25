/**
 * AudioWorkletGlobalScope lacks many window/worker APIs (structuredClone,
 * setTimeout, fetch, …). Code bundled into worklets must not use them — a
 * throw inside a processor silently mutes the instrument.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKLET_SOURCES = [
  'src/audio/worklets/triosc.worklet.ts',
  'src/audio/worklets/recorder.worklet.ts',
  'src/audio/worklets/modsource.worklet.ts',
  'src/synth/dsp/TriOscCore.ts',
  'src/synth/dsp/TriOscSynth.ts',
  'src/synth/dsp/envelope.ts',
  'src/synth/dsp/oscillator.ts',
  'src/synth/dsp/svf.ts',
  'src/synth/dsp/voiceAllocator.ts',
  'src/audio/modsource/ModSourceCore.ts',
  'src/synth/params.ts',
];
const FORBIDDEN = ['structuredClone(', 'setTimeout(', 'setInterval(', 'fetch(', 'requestAnimationFrame(', 'document.', 'window.', 'localStorage'];

describe('worklet code uses only AudioWorkletGlobalScope APIs', () => {
  for (const file of WORKLET_SOURCES) {
    it(file, () => {
      // ignore comments so explanations may mention the forbidden names
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const f of FORBIDDEN) expect(code.includes(f), `${file} uses ${f}`).toBe(false);
    });
  }
});
