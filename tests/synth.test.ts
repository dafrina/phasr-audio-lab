import { describe, expect, it } from 'vitest';
import { TriOscCore } from '../src/synth/dsp/TriOscCore';
import { TriOscSynth } from '../src/synth/dsp/TriOscSynth';
import { allocateVoice } from '../src/synth/dsp/voiceAllocator';
import { Envelope, EnvelopeCoefs, ENV_IDLE, ENV_SUSTAIN } from '../src/synth/dsp/envelope';
import { OscState, WF_SAW, oscSample } from '../src/synth/dsp/oscillator';
import { defaultPatch, sanitizePatch, type TriOscPatch } from '../src/synth/params';
import { FACTORY_PRESETS } from '../src/synth/presets';

const SR = 48000;
const BLOCK = 128;

function render(synth: TriOscSynth, frames: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += BLOCK) synth.render(l, r, i, Math.min(BLOCK, frames - i));
  return { l, r };
}

function renderCore(core: TriOscCore, frames: number, startFrame = 0): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  for (let i = 0; i < frames; i += BLOCK) {
    core.process(startFrame + i, bl, br);
    const n = Math.min(BLOCK, frames - i);
    l.set(bl.subarray(0, n), i);
    r.set(br.subarray(0, n), i);
  }
  return { l, r };
}

function peak(a: Float32Array, from = 0, to = a.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i] as number));
  return p;
}

function rms(a: Float32Array, from = 0, to = a.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (a[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Estimate the fundamental frequency from positive-going zero crossings. */
function estimateFreq(a: Float32Array, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if ((a[i - 1] as number) <= 0 && (a[i] as number) > 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return ((count - 1) * SR) / (last - first);
}

function patchWith(fn: (p: TriOscPatch) => void): TriOscPatch {
  const p = defaultPatch();
  fn(p);
  return sanitizePatch(p);
}

describe('TriOsc synthesis', () => {
  it('produces a sine at the correct pitch', () => {
    const s = new TriOscSynth(SR, defaultPatch());
    s.noteOn(1, 69, 1);
    const { l } = render(s, SR / 2);
    expect(peak(l)).toBeGreaterThan(0.1);
    expect(estimateFreq(l, 4800, 24000)).toBeCloseTo(440, 0);
  });

  it('applies coarse and fine tuning', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].coarse = 12; p.oscs[0].fine = 0; }));
    s.noteOn(1, 57, 1);
    const { l } = render(s, SR / 2);
    expect(estimateFreq(l, 4800, 24000)).toBeCloseTo(440, 0);
    const s2 = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].fine = 100; }));
    s2.noteOn(1, 68, 1);
    expect(estimateFreq(render(s2, SR / 2).l, 4800, 24000)).toBeCloseTo(440, 0);
  });

  it('renders every waveform without NaN and within headroom', () => {
    for (const wf of ['sine', 'triangle', 'saw', 'square', 'pulse', 'noise'] as const) {
      for (const quality of ['classic', 'hq'] as const) {
        const s = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].waveform = wf; p.quality = quality; }));
        s.noteOn(1, 60, 1);
        const { l, r } = render(s, 9600);
        expect(Number.isFinite(rms(l))).toBe(true);
        expect(rms(l)).toBeGreaterThan(0.05);
        expect(peak(l)).toBeLessThan(1.0);
        expect(peak(r)).toBeLessThan(1.0);
      }
    }
  });

  it('keeps the HQ triangle integrator bounded and aligned', () => {
    const st = new OscState();
    st.setPhase(0);
    let mx = 0;
    for (let i = 0; i < SR; i++) mx = Math.max(mx, Math.abs(oscSample(st, 1, 1000 / SR, true, 0.5)));
    expect(mx).toBeLessThan(1.1);
    expect(mx).toBeGreaterThan(0.9);
  });

  it('HQ saw has less aliasing energy than classic (smaller sample-to-sample jumps)', () => {
    const measure = (hq: boolean) => {
      const st = new OscState();
      let maxJump = 0;
      let prev = 0;
      for (let i = 0; i < 4800; i++) {
        const v = oscSample(st, WF_SAW, 3517 / SR, hq, 0.5);
        if (i > 0) maxJump = Math.max(maxJump, Math.abs(v - prev));
        prev = v;
      }
      return maxJump;
    };
    expect(measure(true)).toBeLessThan(measure(false));
  });

  it('pans oscillators and applies stereo detune', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].pan = -1; }));
    s.noteOn(1, 60, 1);
    const { l, r } = render(s, 4800);
    expect(rms(l)).toBeGreaterThan(0.1);
    expect(rms(r)).toBeLessThan(1e-6);
    const s2 = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].stereoDetune = 50; }));
    s2.noteOn(1, 69, 1);
    const o = render(s2, SR);
    expect(estimateFreq(o.l, 4800, SR)).toBeLessThan(440);
    expect(estimateFreq(o.r, 4800, SR)).toBeGreaterThan(440);
  });

  it('AM mode: osc 3 modulates osc 1 and is not heard directly', () => {
    const p = patchWith((x) => {
      x.oscs[0].enabled = false;
      x.oscs[1].enabled = false;
      x.oscs[2].enabled = true;
      x.amMode = true;
    });
    const s = new TriOscSynth(SR, p);
    s.noteOn(1, 60, 1);
    expect(peak(render(s, 4800).l)).toBeLessThan(1e-6);
    const p2 = patchWith((x) => {
      x.oscs[2].enabled = true;
      x.oscs[2].level = 1;
      x.oscs[2].coarse = -24;
      x.amMode = true;
    });
    const plain = new TriOscSynth(SR, patchWith(() => {}));
    const amd = new TriOscSynth(SR, p2);
    plain.noteOn(1, 60, 1);
    amd.noteOn(1, 60, 1);
    // full-depth AM averages the carrier down by roughly half in amplitude
    expect(rms(render(amd, 9600).l, 4800)).toBeLessThan(rms(render(plain, 9600).l, 4800) * 0.85);
  });

  it('releases smoothly to silence and frees the voice', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.ampEnv.release = 0.1; }));
    s.noteOn(1, 60, 1);
    render(s, 4800);
    s.noteOff(1);
    const { l } = render(s, SR / 2);
    expect(rms(l, 0, 480)).toBeGreaterThan(0.05); // release still sounding at first
    expect(peak(l, SR / 4)).toBeLessThan(1e-4);
    expect(s.activeVoiceCount()).toBe(0);
  });

  it('filter low-pass reduces brightness', () => {
    const bright = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].waveform = 'saw'; }));
    const dark = new TriOscSynth(SR, patchWith((p) => { p.oscs[0].waveform = 'saw'; p.filter.enabled = true; p.filter.cutoff = 300; }));
    bright.noteOn(1, 60, 1);
    dark.noteOn(1, 60, 1);
    const hf = (a: Float32Array) => { let s = 0; for (let i = 4801; i < 9600; i++) s += ((a[i] as number) - (a[i - 1] as number)) ** 2; return s; };
    expect(hf(render(dark, 9600).l)).toBeLessThan(hf(render(bright, 9600).l) * 0.2);
  });

  it('all factory presets render audible, finite, bounded audio', () => {
    for (const pr of FACTORY_PRESETS) {
      const s = new TriOscSynth(SR, pr.patch);
      s.noteOn(1, 48, 0.9);
      s.noteOn(2, 55, 0.9);
      s.noteOn(3, 60, 0.9);
      const { l, r } = render(s, SR);
      const level = Math.max(rms(l), rms(r));
      expect(Number.isFinite(level), pr.name).toBe(true);
      expect(level, pr.name).toBeGreaterThan(0.005);
      expect(Math.max(peak(l), peak(r)), pr.name).toBeLessThan(2.5);
    }
  });
});

describe('envelope', () => {
  it('goes through ADSR stages and retriggers from the current level', () => {
    const c = new EnvelopeCoefs();
    c.set({ attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 }, SR);
    const e = new Envelope();
    e.trigger();
    e.advance(c, 240);
    expect(e.value).toBeCloseTo(0.5, 1);
    e.advance(c, SR / 2);
    expect(e.stage).toBe(ENV_SUSTAIN);
    expect(e.value).toBeCloseTo(0.5, 3);
    e.release();
    e.advance(c, 600);
    const mid = e.value;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.5);
    e.trigger();
    const next = e.next(c);
    expect(next).toBeGreaterThan(mid); // no jump to zero on retrigger
    expect(next - mid).toBeLessThan(0.01);
    e.release();
    e.advance(c, SR);
    expect(e.stage).toBe(ENV_IDLE);
  });

  it('parameter changes do not restart a sounding envelope', () => {
    const c = new EnvelopeCoefs();
    c.set({ attack: 0.001, decay: 0.01, sustain: 0.7, release: 0.2 }, SR);
    const e = new Envelope();
    e.trigger();
    e.advance(c, SR / 10);
    c.set({ attack: 2, decay: 3, sustain: 0.6, release: 1 }, SR);
    e.advance(c, SR / 10);
    expect(e.stage).toBe(ENV_SUSTAIN);
    expect(e.value).toBeCloseTo(0.6, 2);
  });
});

describe('voice allocation', () => {
  const slot = (active: boolean, released: boolean, order: number) => ({ active, released, order });

  it('uses the lowest idle voice', () => {
    expect(allocateVoice([slot(true, false, 1), slot(false, false, 0), slot(false, false, 0)], 16)).toEqual({ index: 1, steal: false });
  });
  it('steals the oldest released voice first', () => {
    const slots = [slot(true, false, 1), slot(true, true, 5), slot(true, true, 3), slot(true, false, 2)];
    expect(allocateVoice(slots, 4)).toEqual({ index: 2, steal: true });
  });
  it('steals the oldest held voice when none are released', () => {
    const slots = [slot(true, false, 4), slot(true, false, 2), slot(true, false, 3)];
    expect(allocateVoice(slots, 3)).toEqual({ index: 1, steal: true });
  });
  it('respects the polyphony limit', () => {
    const slots = [slot(true, false, 1), slot(true, false, 2), slot(false, false, 0), slot(false, false, 0)];
    expect(allocateVoice(slots, 2)).toEqual({ index: 0, steal: true });
  });

  it('never exceeds 16 voices and stays deterministic under a note flood', () => {
    const run = () => {
      const s = new TriOscSynth(SR, defaultPatch());
      for (let i = 0; i < 40; i++) {
        s.noteOn(i + 1, 40 + i, 1);
        render(s, 64);
      }
      render(s, 960);
      return s.voices.map((v) => v.noteId);
    };
    const a = run();
    expect(a).toEqual(run());
    const s = new TriOscSynth(SR, defaultPatch());
    for (let i = 0; i < 40; i++) s.noteOn(i + 1, 40 + i, 1);
    render(s, 960);
    expect(s.activeVoiceCount()).toBeLessThanOrEqual(16);
  });

  it('overlapping notes of the same pitch release independently', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.ampEnv.release = 0.01; }));
    s.noteOn(1, 60, 1);
    s.noteOn(2, 60, 1);
    render(s, 480);
    s.noteOff(1);
    render(s, SR / 4);
    expect(s.activeVoiceCount()).toBe(1);
    s.noteOff(2);
    render(s, SR / 4);
    expect(s.activeVoiceCount()).toBe(0);
  });
});

describe('voice modes', () => {
  it('mono legato glides without retriggering and returns to held note', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.voice.mode = 'mono'; p.voice.legato = true; p.ampEnv.release = 0.01; }));
    s.noteOn(1, 57, 1);
    render(s, SR / 4);
    s.noteOn(2, 69, 1);
    const a = render(s, SR / 4);
    expect(estimateFreq(a.l, 2400, SR / 4)).toBeCloseTo(440, 0);
    expect(s.activeVoiceCount()).toBe(1);
    s.noteOff(2);
    const b = render(s, SR / 4);
    expect(estimateFreq(b.l, 2400, SR / 4)).toBeCloseTo(220, 0);
    s.noteOff(1);
    render(s, SR / 4);
    expect(s.activeVoiceCount()).toBe(0);
  });

  it('portamento glides pitch over time', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.voice.mode = 'mono'; p.voice.legato = true; p.voice.glide = 0.3; }));
    s.noteOn(1, 57, 1);
    render(s, SR / 4);
    s.noteOn(2, 69, 1);
    const g = render(s, SR);
    const early = estimateFreq(g.l, 0, 4800);
    const late = estimateFreq(g.l, SR / 2, SR);
    expect(early).toBeLessThan(400);
    expect(late).toBeCloseTo(440, 0);
  });

  it('sustain pedal holds released notes until pedal up', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.ampEnv.release = 0.01; }));
    s.setSustain(true);
    s.noteOn(1, 60, 1);
    render(s, 480);
    s.noteOff(1);
    render(s, SR / 4);
    expect(s.activeVoiceCount()).toBe(1);
    s.setSustain(false);
    render(s, SR / 4);
    expect(s.activeVoiceCount()).toBe(0);
  });

  it('pitch bend shifts by the bend range', () => {
    const s = new TriOscSynth(SR, patchWith((p) => { p.voice.bendRange = 12; }));
    s.setPitchBend(1);
    s.noteOn(1, 57, 1);
    expect(estimateFreq(render(s, SR / 2).l, 4800, SR / 2)).toBeCloseTo(440, 0);
  });

  it('switching presets while notes play keeps them sounding and releasable', () => {
    const s = new TriOscSynth(SR, (FACTORY_PRESETS[3] as { patch: TriOscPatch }).patch);
    s.noteOn(1, 60, 1);
    s.noteOn(2, 64, 1);
    render(s, 4800);
    for (const p of FACTORY_PRESETS) {
      s.setPatch(p.patch);
      render(s, 256);
    }
    s.allNotesOff();
    render(s, SR * 6);
    expect(s.activeVoiceCount()).toBe(0);
  });
});

describe('sample-accurate event core', () => {
  it('starts a note on its exact frame', () => {
    const core = new TriOscCore(SR, patchWith((p) => { p.ampEnv.attack = 0.001; }));
    const at = 1000 / SR; // frame 1000
    core.handleMessage({ type: 'noteOn', time: at, id: 1, note: 60, velocity: 1 });
    const { l } = renderCore(core, 2048);
    expect(peak(l, 0, 1000)).toBe(0);
    expect(peak(l, 1001, 1100)).toBeGreaterThan(0);
  });

  it('cancel drops future notes and releases sounding ones (no stuck notes)', () => {
    const core = new TriOscCore(SR, patchWith((p) => { p.ampEnv.release = 0.02; }));
    core.handleMessage({
      type: 'events',
      events: [
        { type: 'noteOn', time: 0.01, id: 1, note: 60, velocity: 1 },
        { type: 'noteOff', time: 5, id: 1 },
        { type: 'noteOn', time: 2, id: 2, note: 64, velocity: 1 },
        { type: 'noteOff', time: 3, id: 2 },
      ],
    });
    renderCore(core, 4800);
    expect(core.synth.activeVoiceCount()).toBe(1);
    core.handleMessage({ type: 'cancel', time: 0.2 });
    renderCore(core, SR * 3, 4800);
    expect(core.synth.activeVoiceCount()).toBe(0);
    expect(core.pendingEventCount()).toBe(0);
  });

  it('rapid note on/off never leaves voices active', () => {
    const core = new TriOscCore(SR, patchWith((p) => { p.ampEnv.release = 0.01; }));
    const events = [];
    for (let i = 0; i < 500; i++) {
      const t = i * 0.0007;
      events.push({ type: 'noteOn' as const, time: t, id: i + 1, note: 40 + (i % 40), velocity: 1 });
      events.push({ type: 'noteOff' as const, time: t + 0.0003, id: i + 1 });
    }
    core.handleMessage({ type: 'events', events });
    renderCore(core, SR);
    expect(core.synth.activeVoiceCount()).toBe(0);
  });

  it('panic silences within a few milliseconds', () => {
    const core = new TriOscCore(SR, patchWith((p) => { p.ampEnv.release = 5; }));
    core.handleMessage({ type: 'noteOn', time: -1, id: 1, note: 60, velocity: 1 });
    renderCore(core, 4800);
    core.handleMessage({ type: 'panic' });
    const { l } = renderCore(core, 4800, 4800);
    expect(peak(l, 480)).toBe(0);
  });
});

describe('block kernels match the per-sample reference exactly', () => {
  it('renderOscBlock = n × oscSample for every waveform and quality', async () => {
    const { renderOscBlock, oscSample, OscState: OS } = await import('../src/synth/dsp/oscillator');
    for (const wf of [0, 1, 2, 3, 4]) {
      for (const hq of [false, true]) {
        const a = new OS();
        const b = new OS();
        a.setPhase(0.37);
        b.setPhase(0.37);
        const dt = 1234.5 / 48000;
        const ref = new Float64Array(500);
        for (let i = 0; i < 500; i++) ref[i] = oscSample(a, wf, dt, hq, 0.3);
        const out = new Float64Array(500);
        for (let i = 0; i < 500; i += 32) {
          const blk = new Float64Array(32);
          renderOscBlock(b, wf, dt, hq, 0.3, blk, Math.min(32, 500 - i));
          out.set(blk.subarray(0, Math.min(32, 500 - i)), i);
        }
        expect(out, `wf ${wf} hq ${hq}`).toEqual(ref);
        expect(b.phase).toBe(a.phase);
      }
    }
  });

  it('svfBlock = n × Svf.process', async () => {
    const { Svf, SvfCoefs, svfBlock, FILTER_LP, FILTER_HP, FILTER_BP } = await import('../src/synth/dsp/svf');
    for (const mode of [FILTER_LP, FILTER_HP, FILTER_BP]) {
      const c = new SvfCoefs();
      c.set(1500, 0.6, 48000);
      const f1 = new Svf();
      const f2 = new Svf();
      const x = Float64Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.3) + ((i * 7919) % 13) / 13 - 0.5);
      const ref = x.map((v) => f1.process(v, c, mode));
      const buf = x.slice();
      svfBlock(f2, c, mode, buf, 256);
      expect(buf).toEqual(ref);
    }
  });
});
