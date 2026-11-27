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
  'src/synth/dsp/bend.ts',
  'src/synth/dsp/TriOscSynth.ts',
  'src/synth/dsp/envelope.ts',
  'src/synth/dsp/oscillator.ts',
  'src/synth/dsp/svf.ts',
  'src/synth/dsp/voiceAllocator.ts',
  'src/audio/modsource/ModSourceCore.ts',
  'src/synth/params.ts',
  'src/audio/worklets/keys.worklet.ts',
  'src/keys/params.ts',
  'src/keys/dsp/KeysCore.ts',
  'src/keys/dsp/KeysSynth.ts',
  'src/keys/dsp/common.ts',
  'src/keys/dsp/piano.ts',
  'src/keys/dsp/epiano.ts',
  'src/keys/dsp/organ.ts',
  'src/keys/dsp/analog.ts',
  'src/keys/dsp/sub808.ts',
  'src/audio/worklets/phaser.worklet.ts',
  'src/audio/phaser/PhaserCore.ts',
  'src/audio/worklets/room.worklet.ts',
  'src/audio/room/RoomCore.ts',
  'src/audio/worklets/satgain.worklet.ts',
  'src/audio/saturator/AutoGainCore.ts',
  'src/audio/worklets/crush.worklet.ts',
  'src/audio/saturator/CrushCore.ts',
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
