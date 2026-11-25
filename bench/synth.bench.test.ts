/** Not part of the test suite: run with `npx vitest run --config bench/vitest.config.ts`. */
import { it } from 'vitest';
import { TriOscSynth } from '../src/synth/dsp/TriOscSynth';
import { FACTORY_PRESETS } from '../src/synth/presets';

it('TriOsc render throughput', () => {
  const SR = 48000;
  const SECONDS = 5;
  const results: string[] = [];
  for (const name of ['Init Sine', 'Detuned Saw', 'Soft Pad', 'Deep Bass']) {
    const patch = FACTORY_PRESETS.find((p) => p.name === name)!.patch;
    const s = new TriOscSynth(SR, patch);
    // 16-voice worst case: a cluster held for the whole run
    for (let i = 0; i < 16; i++) s.noteOn(i + 1, 40 + i * 2, 0.8);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let i = 0; i < 20; i++) s.render(l, r, 0, 128); // warm up JIT
    const t0 = performance.now();
    const blocks = (SR * SECONDS) / 128;
    for (let b = 0; b < blocks; b++) {
      l.fill(0);
      r.fill(0);
      s.render(l, r, 0, 128);
    }
    const ms = performance.now() - t0;
    results.push(`${name.padEnd(12)} 16 voices: ${(SECONDS * 1000 / ms).toFixed(1)}× realtime (${(ms / SECONDS).toFixed(1)} ms per audio second)`);
  }
  console.log('\n' + results.join('\n'));
}, 120000);
