/** Not part of the test suite: run with `npm run bench`. Keyforge engines, drum synthesis and phaser throughput. */
import { it } from 'vitest';
import { KeysSynth } from '../src/keys/dsp/KeysSynth';
import { KEYS_PRESETS } from '../src/keys/presets';
import { FACTORY_KITS } from '../src/drums/kit';
import { renderDrumVoice } from '../src/drums/synth';
import { PhaserCore } from '../src/audio/phaser/PhaserCore';
import { environment, fmtX, repeat } from './stats';

const SR = 48000;
const BLOCK = 128;

/** play `chord` every `everySec` for `seconds`, return × realtime */
function keysSpeed(preset: string, chord: number[], everySec: number, seconds: number): number {
  const p = KEYS_PRESETS.find((x) => x.name === preset)!;
  const s = new KeysSynth(SR, { engine: p.engine, params: { ...p.params } });
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  let id = 1;
  const strike = () => {
    for (const n of chord) s.noteOn(id++, n, 0.8);
  };
  strike();
  for (let i = 0; i < 40; i++) s.render(l, r, 0, BLOCK); // JIT warm-up
  const blocks = Math.round((SR * seconds) / BLOCK);
  const every = Math.round((SR * everySec) / BLOCK);
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    if (b % every === 0) {
      for (let k = id - chord.length; k < id; k++) s.noteOff(k);
      strike();
    }
    l.fill(0);
    r.fill(0);
    s.render(l, r, 0, BLOCK);
  }
  return (seconds * 1000) / (performance.now() - t0);
}

it('Keyforge render throughput', () => {
  const chord = [48, 55, 60, 64, 67, 72];
  const rows: [string, number[], number][] = [
    ['Concert Grand', chord, 0.5],
    ['Felt Piano', chord, 0.5],
    ['Classic Tine EP', chord, 0.5],
    ['Jazz Tonewheel', chord, 1],
    ['Warm Pad', chord, 1],
    ['Supersaw Lead', [60, 64, 67], 0.25],
    ['Reese Bass', [36], 0.25],
    ['Trap 808', [36], 0.5],
  ];
  const out: string[] = [];
  for (const [name, notes, every] of rows) {
    const x = repeat(() => keysSpeed(name, notes, every, 6));
    out.push(`${name.padEnd(16)} ${String(notes.length).padStart(2)} notes every ${every}s: ${fmtX(x)}`);
  }
  console.log(`\n${environment()}\n` + out.join('\n'));
}, 300000);

it('Drum kit synthesis (all pads of every kit)', () => {
  const out: string[] = [];
  for (const k of FACTORY_KITS) {
    const t0 = performance.now();
    for (const pad of k.kit.pads) if (pad.source.kind === 'synth') renderDrumVoice(pad.source, SR);
    out.push(`${k.name.padEnd(12)} ${(performance.now() - t0).toFixed(1)} ms`);
  }
  console.log('\n' + out.join('\n'));
}, 120000);

it('Phaser throughput', () => {
  const ph = new PhaserCore(SR, 6);
  const inL = new Float32Array(BLOCK).map(() => Math.random() - 0.5);
  const inR = new Float32Array(BLOCK).map(() => Math.random() - 0.5);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  const params = { center: 700, depth: 2, feedback: 0.5, rate: 0.3, stereo: 0.5, shift: 0 };
  const seconds = 20;
  const blocks = (SR * seconds) / BLOCK;
  const x = repeat(() => {
    const t0 = performance.now();
    for (let b = 0; b < blocks; b++) ph.process(inL, inR, oL, oR, params);
    return (seconds * 1000) / (performance.now() - t0);
  });
  console.log(`\nPhaser 6 stages stereo: ${fmtX(x, 0)}`);
}, 120000);
