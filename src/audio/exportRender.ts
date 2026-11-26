/**
 * Offline WAV export.
 *
 * Builds the same graph as realtime playback inside an OfflineAudioContext —
 * track channels with insert effects, instruments (TriOsc worklet with all
 * note events passed up front, drum racks with pre-scheduled hits), audio
 * clips, automation ramps, sidechain modulators and the master chain — then
 * renders faster than realtime. Scheduling uses the exact same `planWindow`
 * as the transport, so the export matches what you hear.
 *
 * Progress is real: the render is suspended at regular points in time.
 */

import { EffectChain } from './effectChain';
import { SendBusNode } from './sendBus';
import { nextNoteInstanceId } from '../core/ids';
import { ticksPerBar, ticksPerBeatUnit } from '../core/time';
import type { Project } from '../project/types';
import type { SynthEvent } from '../synth/dsp/TriOscCore';
import type { AssetRegistry } from './assets';
import { estimateTailSeconds, exportRange, trackAudibleFn, type ExportRangeMode } from './exportPlan';
import { createInstrumentNode } from './instruments';
import { ModulationRouter } from './modulation';
import { planWindow, toParamSegments } from './scheduling';
import { automatedInstKeys, targetInfo } from '../project/automation';
import { TrackChannel, dbToGainFader } from './trackChannel';
import { decodeWav, encodeWav, type WavFormat } from './wav';
import modsourceWorkletUrl from './worklets/modsource.worklet.ts?worker&url';
import trioscWorkletUrl from './worklets/triosc.worklet.ts?worker&url';
import keysWorkletUrl from './worklets/keys.worklet.ts?worker&url';
import { withChordsExpanded } from '../chords/expand';

export interface ExportOptions {
  sampleRate: number;
  range: ExportRangeMode;
  /** render instrument releases and effect tails after the range */
  tail: boolean;
  format: WavFormat;
  onProgress?: (fraction: number) => void;
}

export interface ExportResult {
  wav: ArrayBuffer;
  sampleRate: number;
  channels: number;
  frames: number;
  durationSec: number;
  rangeSec: number;
  tailSec: number;
  peakDb: number;
  /** checks run on the encoded file */
  verified: { header: boolean; length: boolean; finite: boolean };
  /** the rendered (trimmed) samples, for other encoders such as MP3 */
  audio: { left: Float32Array; right: Float32Array };
}

const SILENCE = Math.pow(10, -90 / 20);

export async function renderProjectToWav(source: Project, assets: AssetRegistry, opts: ExportOptions): Promise<ExportResult> {
  const project = withChordsExpanded(source);
  const range = exportRange(project, opts.range);
  const audible = trackAudibleFn(project);
  const tailMax = opts.tail ? estimateTailSeconds(project, audible) : 0;
  const sr = opts.sampleRate;
  const frames = Math.max(1, Math.ceil((range.seconds + tailMax) * sr));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: sr });
  await ctx.audioWorklet.addModule(trioscWorkletUrl);
  await ctx.audioWorklet.addModule(keysWorkletUrl);
  await ctx.audioWorklet.addModule(modsourceWorkletUrl);

  // master: insert effects → volume → (safety limiter) → output. The metronome is never exported.
  const masterFx = new EffectChain(ctx, false);
  masterFx.sync(project.master.effects ?? [], project.bpm);
  const masterIn = masterFx.input;
  const masterGain = new GainNode(ctx, { gain: dbToGainFader(project.master.volumeDb) });
  masterFx.output.connect(masterGain);
  if (project.master.limiter) {
    const lim = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.12 });
    masterGain.connect(lim);
    lim.connect(ctx.destination);
  } else {
    masterGain.connect(ctx.destination);
  }

  // one plan for the whole range; the "loop" end makes clips and notes stop exactly at the range end
  const ts = project.timeSignature;
  const plan = planWindow(
    {
      bpm: project.bpm,
      loop: { enabled: true, start: range.startTick, end: range.endTick },
      beatTicks: ticksPerBeatUnit(ts),
      barTicks: ticksPerBar(ts),
      metronome: false,
      tracks: project.tracks,
      clips: Object.values(project.clips),
    },
    { tick: range.startTick, time: 0, fresh: true },
    range.seconds,
  );

  // send channels: tracks' sends → their effects → master
  const sendBuses = (project.sends ?? []).map((b) => {
    const node = new SendBusNode(ctx, masterIn, false);
    node.update(b, project.bpm, true);
    return node;
  });
  const sendInputs = sendBuses.map((b) => b.input);
  const channels = new Map<string, TrackChannel>();
  const resolveAsset = (id: string) => assets.get(id)?.buffer;
  for (const track of project.tracks) {
    const ch = new TrackChannel(ctx, track, masterIn, false);
    ch.update(track, audible(track), true);
    ch.setSends(track.sends ?? [], sendInputs, true);
    ch.syncEffects(track.effects, project.bpm, track);
    channels.set(track.id, ch);
    if (track.kind === 'instrument' && track.instrument) {
      const events: SynthEvent[] = [];
      for (const n of plan.notes) {
        if (n.trackId !== track.id) continue;
        const id = nextNoteInstanceId();
        events.push({ type: 'noteOn', time: n.onTime, id, note: n.pitch, velocity: n.velocity });
        events.push({ type: 'noteOff', time: n.offTime, id });
      }
      // instrument-parameter automation goes in with the notes (offline needs everything up front)
      for (const a of plan.automation) {
        if (a.trackId !== track.id || a.target.kind !== 'inst') continue;
        const exp = targetInfo(track, a.target)?.spec.curve === 'exp';
        events.push(...toParamSegments(a.target.param, a.events, null, exp).segments);
      }
      const node = createInstrumentNode(ctx, track.instrument, { resolveAsset, events, bpm: project.bpm });
      node.setAutomatedKeys(automatedInstKeys(track));
      ch.attachInstrument(node, track.instrument.type);
    }
  }

  for (const a of plan.audio) {
    const ch = channels.get(a.trackId);
    const buffer = assets.get(a.clip.assetId)?.buffer;
    if (!ch || !buffer) continue;
    const c = a.clip;
    ch.playAudio({
      buffer,
      when: a.when,
      stopAt: a.stopAt,
      sourcePos: a.sourcePos,
      gain: c.gain,
      loop: c.loop && c.loopSeconds > 0 ? { start: c.sourceOffset, end: c.sourceOffset + c.loopSeconds } : null,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      clipOffset: a.clipOffset,
      clipDuration: a.stopAt - a.when,
    });
  }

  for (const a of plan.automation) {
    if (a.target.kind === 'inst') continue; // handled with the instrument's events
    for (const t of channels.get(a.trackId)?.automationParams(a.target) ?? []) {
      for (const e of a.events) {
        const v = t.map(e.value);
        if (e.kind === 'set') t.param.setValueAtTime(v, e.time);
        else if (t.exp && v > 0) t.param.exponentialRampToValueAtTime(v, e.time);
        else t.param.linearRampToValueAtTime(v, e.time);
      }
    }
  }

  // sidechains: MIDI routes get every trigger up front
  const triggers = new Map<string, { time: number; note: number }[]>();
  for (const n of plan.notes) {
    const arr = triggers.get(n.trackId) ?? [];
    arr.push({ time: n.onTime, note: n.pitch });
    triggers.set(n.trackId, arr);
  }
  new ModulationRouter(ctx, (id) => channels.get(id), false).sync(project, triggers);

  // real progress: suspend at evenly spaced points of the render timeline
  const totalSec = frames / sr;
  const steps = Math.min(50, Math.max(4, Math.ceil(totalSec)));
  for (let k = 1; k < steps; k++) {
    const t = (totalSec * k) / steps;
    void ctx.suspend(t).then(() => {
      opts.onProgress?.(k / steps);
      void ctx.resume();
    });
  }
  const rendered = await ctx.startRendering();
  opts.onProgress?.(1);

  // trim the tail to where the sound actually ends (never shorter than the range)
  const l = rendered.getChannelData(0);
  const r = rendered.getChannelData(1);
  const rangeFrames = Math.min(frames, Math.round(range.seconds * sr));
  let last = rangeFrames;
  for (let i = frames - 1; i >= rangeFrames; i--) {
    if (Math.abs(l[i] as number) > SILENCE || Math.abs(r[i] as number) > SILENCE) {
      last = i + 1;
      break;
    }
  }
  const outFrames = Math.min(frames, opts.tail ? last + Math.round(0.05 * sr) : rangeFrames);
  const L = l.slice(0, outFrames);
  const R = r.slice(0, outFrames);
  let peak = 0;
  let finite = true;
  for (let i = 0; i < outFrames; i++) {
    const a = Math.abs(L[i] as number);
    const b = Math.abs(R[i] as number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) finite = false;
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const wav = encodeWav([L, R], sr, { format: opts.format });
  // verify the file we're about to hand over
  const check = decodeWav(wav);
  const verified = {
    header: check.sampleRate === sr && check.channels.length === 2 && check.format === opts.format,
    length: check.channels[0]?.length === outFrames,
    finite,
  };
  return {
    wav,
    sampleRate: sr,
    channels: 2,
    frames: outFrames,
    durationSec: outFrames / sr,
    rangeSec: range.seconds,
    tailSec: Math.max(0, outFrames / sr - range.seconds),
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    verified,
    audio: { left: L, right: R },
  };
}

