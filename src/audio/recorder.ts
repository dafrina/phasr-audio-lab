/**
 * Audio recording controller (one track at a time).
 *
 * Lifecycle:
 *   arm(track)  → open the input (getUserMedia → source → input gain → recorder
 *                 worklet + meter; optional monitoring into the track's channel)
 *   start()     → transport plays (with count-in); the worklet starts capturing
 *                 at the exact frame where the timeline reaches the start tick
 *   stop()      → capture ends at the current frame; chunks are assembled into
 *                 an AudioBuffer + float WAV asset and a latency-compensated clip
 *
 * Failures (permission denied, device unplugged, browser suspending audio)
 * end the take gracefully: whatever was captured is kept as a clip.
 *
 * Arming an instrument track records MIDI instead: every live note sent to
 * that track (Web MIDI, computer keys, on-screen keyboard) is placed at the
 * timeline position the player was hearing and becomes a new MIDI clip.
 */
import { ticksPerBar } from '../core/time';
import { createAudioClip, createMidiClip } from '../project/defaults';
import type { Project } from '../project/types';
import { getProject, useProjectStore } from '../state/projectStore';
import { REC_KEYS, useRecordingStore, writeLS, type InputDevice } from '../state/recordingStore';
import { uiToast, useUiStore } from '../state/uiStore';
import { engine } from './engine';
import { StereoMeter, type MeterReading } from './meter';
import { assembleChunks, estimateLatency, LivePeaks, placeRecordedClip, type CapturedChunk } from './recordingMath';
import { encodeWav } from './wav';
import { heardContextTime, MidiTake, type LiveNote } from './midiTake';

const set = (s: Partial<ReturnType<typeof useRecordingStore.getState>>) => useRecordingStore.setState(s);

interface OpenInput {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  meter: StereoMeter;
  node: AudioWorkletNode;
  sink: GainNode;
  monitor: GainNode;
  monitorTarget: AudioNode | null;
  deviceId: string;
}

interface Take {
  trackId: string;
  startTick: number;
  startTime: number;
  sampleRate: number;
  chunks: CapturedChunk[];
  peaks: LivePeaks;
  latencySec: number;
  done: Promise<void>;
  resolveDone: () => void;
}

export type LiveRecordingView =
  | { kind: 'audio'; trackId: string; startTick: number; startTime: number; sampleRate: number; peaks: LivePeaks }
  | { kind: 'midi'; trackId: string; startTick: number; notes: readonly LiveNote[] };

interface MidiRecording {
  trackId: string;
  take: MidiTake;
  /** live voice id → take key */
  keys: Map<number, number>;
  unsubInput: () => void;
}

function describeError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it in the browser’s site settings to record.';
    case 'NotFoundError':
      return 'No audio input device was found. Connect a microphone or audio interface.';
    case 'OverconstrainedError':
      return 'The selected input device is no longer available. Choose another input.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The input device is busy or failed to start (another app may be using it).';
    default:
      return `Could not open the audio input: ${e instanceof Error ? e.message : String(e)}`;
  }
}

class AudioRecorder {
  private input: OpenInput | null = null;
  private take: Take | null = null;
  private midi: MidiRecording | null = null;
  private opening: Promise<boolean> | null = null;
  private unsubTransport: (() => void) | null = null;
  private countInTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.('devicechange', () => void this.onDeviceChange());
    }
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async refreshDevices(): Promise<InputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
      set({ inputs });
      return inputs;
    } catch {
      return [];
    }
  }

  private async onDeviceChange(): Promise<void> {
    const inputs = await this.refreshDevices();
    const cur = this.input;
    if (cur && cur.deviceId && cur.deviceId !== 'default' && !inputs.some((d) => d.deviceId === cur.deviceId)) {
      this.handleInputLost('The recording input was disconnected.');
    }
  }

  async selectDevice(deviceId: string): Promise<void> {
    set({ deviceId });
    writeLS(REC_KEYS.DEVICE_KEY, deviceId);
    if (this.take) return; // never switch devices mid-take
    if (this.input) {
      this.closeInput();
      await this.openInput();
    }
  }

  setManualOffset(ms: number): void {
    const v = Math.max(-500, Math.min(500, Math.round(ms)));
    set({ manualOffsetMs: v });
    writeLS(REC_KEYS.OFFSET_KEY, String(v));
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  isInputOpen(): boolean {
    return this.input !== null;
  }

  openInput(): Promise<boolean> {
    this.opening ??= this.doOpen().finally(() => (this.opening = null));
    return this.opening;
  }

  private async doOpen(): Promise<boolean> {
    if (this.input) return true;
    await engine.resume();
    const ctx = engine.ctx;
    if (!ctx) return false;
    if (!navigator.mediaDevices?.getUserMedia) {
      set({ error: 'Audio input is not available in this browser (requires a secure context).', status: 'idle' });
      uiToast('error', 'Audio input is not available in this browser.');
      return false;
    }
    set({ status: 'opening', error: null });
    const deviceId = useRecordingStore.getState().deviceId;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          // a DAW wants the raw signal, not voice-call processing
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
    } catch (e) {
      // a remembered device may be gone: retry once with the default input
      if (deviceId && e instanceof DOMException && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        set({ deviceId: '' });
        return this.doOpen();
      }
      const msg = describeError(e);
      set({ error: msg, status: 'idle' });
      uiToast('error', msg);
      return false;
    }
    const track = stream.getAudioTracks()[0];
    const source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
    const gain = new GainNode(ctx);
    const meter = new StereoMeter(ctx, true);
    const node = new AudioWorkletNode(ctx, 'phasr-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit', // mono inputs are up-mixed to both channels
      channelInterpretation: 'speakers',
    });
    node.onprocessorerror = () => this.handleInputLost('The recorder stopped unexpectedly.');
    const sink = new GainNode(ctx, { gain: 0 });
    const monitor = new GainNode(ctx, { gain: 0 });
    source.connect(gain);
    gain.connect(node);
    gain.connect(meter.input);
    gain.connect(monitor);
    node.connect(sink);
    sink.connect(ctx.destination); // keeps the worklet pulled; silent
    node.port.onmessage = (e: MessageEvent<{ type: 'chunk'; l: Float32Array; r: Float32Array; frames: number } | { type: 'done'; frames: number }>) =>
      this.onWorkletMessage(e.data);
    track?.addEventListener('ended', () => this.handleInputLost('The recording input stopped (device disconnected or permission revoked).'));
    const settings = track?.getSettings();
    this.input = { stream, source, gain, meter, node, sink, monitor, monitorTarget: null, deviceId: settings?.deviceId ?? deviceId };
    set({ status: 'ready', inputLabel: track?.label ?? 'Input', error: null, autoLatencyMs: Math.round(this.latencySec(false) * 1000) });
    await this.refreshDevices(); // labels become available after permission
    this.syncMonitor(getProject());
    return true;
  }

  closeInput(): void {
    const inp = this.input;
    if (!inp) return;
    this.input = null;
    for (const t of inp.stream.getTracks()) t.stop();
    inp.node.port.postMessage({ type: 'dispose' });
    for (const n of [inp.source, inp.gain, inp.node, inp.sink, inp.monitor]) n.disconnect();
    inp.meter.dispose();
    if (useRecordingStore.getState().status !== 'idle') set({ status: 'idle', inputLabel: null });
  }

  readInputMeter(out: MeterReading): MeterReading {
    if (!this.input) {
      out.peakL = 0;
      out.peakR = 0;
      return out;
    }
    return this.input.meter.read(out);
  }

  private handleInputLost(message: string): void {
    if (!this.input) return;
    if (this.take) {
      uiToast('error', `${message} The audio captured so far was kept.`);
      void this.stop();
    } else {
      uiToast('error', message);
    }
    // closing after stop() posted its final message: captured chunks already arrived or will via 'done' timeout
    setTimeout(() => this.closeInput(), 50);
    set({ error: message });
  }

  // -------------------------------------------------------------------------
  // Arming & monitoring (driven by project state)
  // -------------------------------------------------------------------------

  /** Arm one track (disarming all others), or disarm it if already armed. Audio tracks open the input. */
  async toggleArm(trackId: string): Promise<void> {
    const p = getProject();
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (this.isRecording()) {
      uiToast('info', 'Stop recording before changing the armed track.');
      return;
    }
    const arm = !track.armed;
    useProjectStore.getState().commit(
      arm ? 'Arm track' : 'Disarm track',
      (prev) => ({ ...prev, tracks: prev.tracks.map((t) => ({ ...t, armed: t.id === trackId ? arm : false })) }),
      { skipHistory: true },
    );
    if (arm && track.kind === 'audio') await this.openInput();
  }

  setMonitor(trackId: string, on: boolean): void {
    useProjectStore.getState().commit(
      on ? 'Monitor on' : 'Monitor off',
      (prev) => ({ ...prev, tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, monitor: on } : t)) }),
      { skipHistory: true },
    );
  }

  /** Called on every project change: keep armed state, input and monitoring consistent. */
  syncFromProject(p: Project): void {
    const armed = p.tracks.find((t) => t.armed);
    const armedId = armed?.id ?? null;
    if (useRecordingStore.getState().armedTrackId !== armedId) set({ armedTrackId: armedId });
    if (armed?.kind !== 'audio' && this.input && !this.take) this.closeInput();
    if (this.midi && !p.tracks.some((t) => t.id === this.midi?.trackId)) {
      uiToast('error', 'The track being recorded was deleted. Recording stopped.');
      this.endMidi(false);
    }
    // (an armed track whose input is closed — e.g. after a reload — opens lazily on the next record press)
    if (this.take && !p.tracks.some((t) => t.id === this.take?.trackId)) {
      uiToast('error', 'The track being recorded was deleted. Recording stopped.');
      this.abort();
    }
    this.syncMonitor(p);
  }

  private syncMonitor(p: Project): void {
    const inp = this.input;
    if (!inp || !engine.ctx) return;
    const armed = p.tracks.find((t) => t.armed && t.kind === 'audio');
    const target = armed && armed.monitor ? engine.channelInput(armed.id) : null;
    if (target === inp.monitorTarget) return;
    const t = engine.ctx.currentTime;
    if (inp.monitorTarget) {
      inp.monitor.gain.setTargetAtTime(0, t, 0.005);
      const old = inp.monitorTarget;
      setTimeout(() => {
        try {
          inp.monitor.disconnect(old);
        } catch {
          // already disconnected
        }
      }, 30);
    }
    if (target) {
      inp.monitor.connect(target);
      inp.monitor.gain.setTargetAtTime(1, t, 0.005);
    }
    inp.monitorTarget = target;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  isRecording(): boolean {
    return this.take !== null || this.midi !== null;
  }

  private latencySec(includeManual = true): number {
    const ctx = engine.ctx;
    const track = this.input?.stream.getAudioTracks()[0];
    const settings = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    return estimateLatency({
      baseLatency: ctx?.baseLatency,
      outputLatency: ctx?.outputLatency,
      inputLatency: settings?.latency,
      manualOffsetMs: includeManual ? useRecordingStore.getState().manualOffsetMs : 0,
    });
  }

  async toggleRecord(): Promise<void> {
    if (this.isRecording()) await this.stop();
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.isRecording()) return;
    const p = getProject();
    let armed = p.tracks.find((t) => t.armed);
    if (!armed) {
      // convenience: arm the selected track if there is one
      const sel = useUiStore.getState().selectedTrackId;
      const selTrack = p.tracks.find((t) => t.id === sel);
      if (!selTrack) {
        uiToast('info', 'Arm a track (R button in the track header) to record: audio tracks record the input, instrument tracks record MIDI.');
        return;
      }
      await this.toggleArm(selTrack.id);
      armed = getProject().tracks.find((t) => t.id === selTrack.id);
    }
    if (!armed) return;
    if (armed.kind === 'instrument') {
      this.startMidi(armed.id);
      return;
    }
    if (!(await this.openInput())) return;
    const ctx = engine.ctx;
    const transport = engine.transport;
    const inp = this.input;
    if (!ctx || !transport || !inp) return;
    if (transport.isPlaying()) transport.pause(); // restart cleanly with a count-in from here
    const startTick = Math.max(0, Math.round(transport.getTick()));
    const project = getProject();
    transport.play({ countInBars: project.countInBars, fromTick: startTick });
    const { time: startTime } = transport.playStartInfo();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    this.take = {
      trackId: armed.id,
      startTick,
      startTime,
      sampleRate: ctx.sampleRate,
      chunks: [],
      peaks: new LivePeaks(),
      latencySec: this.latencySec(),
      done,
      resolveDone,
    };
    inp.node.port.postMessage({ type: 'start', frame: Math.round(startTime * ctx.sampleRate) });
    set({ status: project.countInBars > 0 ? 'countIn' : 'recording', autoLatencyMs: Math.round(this.latencySec(false) * 1000), error: null });
    this.countInTimer = setTimeout(() => {
      if (this.take) set({ status: 'recording' });
    }, Math.max(0, (startTime - ctx.currentTime) * 1000));
    // stopping the transport (Space, Stop, interruption) ends the take
    this.unsubTransport = transport.subscribe((snap) => {
      if (snap.state !== 'playing' && this.take) void this.stop();
    });
  }

  // -------------------------------------------------------------------------
  // MIDI recording
  // -------------------------------------------------------------------------

  /** timeline tick the player was hearing at a performance.now() timestamp */
  private heardTick(atMs: number): number {
    const ctx = engine.ctx;
    const transport = engine.transport;
    if (!ctx || !transport) return 0;
    let out: AudioTimestamp | null = null;
    try {
      out = ctx.getOutputTimestamp?.() ?? null;
    } catch {
      out = null;
    }
    const t = heardContextTime(atMs, out, { currentTime: ctx.currentTime, outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency, nowMs: performance.now() });
    return transport.tickAtContextTime(t);
  }

  private startMidi(trackId: string): void {
    const ctx = engine.ctx;
    const transport = engine.transport;
    if (!ctx || !transport) return;
    if (transport.isPlaying()) transport.pause();
    const project = getProject();
    const startTick = Math.max(0, Math.round(transport.getTick()));
    const loop = project.loop.enabled && project.loop.end > startTick ? { start: project.loop.start, end: project.loop.end } : null;
    transport.play({ countInBars: project.countInBars, fromTick: startTick });
    const { time: startTime } = transport.playStartInfo();
    const take = new MidiTake(startTick, loop);
    const keys = new Map<number, number>();
    const unsubInput = engine.onLiveInput((e) => {
      if (e.trackId !== trackId) return;
      if (e.type === 'noteOn') {
        keys.set(e.id, e.id);
        take.noteOn(e.id, e.note, e.velocity, this.heardTick(e.at));
      } else if (e.type === 'noteOff') {
        if (keys.delete(e.id)) take.noteOff(e.id, this.heardTick(e.at));
      } else take.sustain(e.on, this.heardTick(e.at));
    });
    this.midi = { trackId, take, keys, unsubInput };
    set({ status: project.countInBars > 0 ? 'countIn' : 'recording', error: null });
    this.countInTimer = setTimeout(() => {
      if (this.midi) set({ status: 'recording' });
    }, Math.max(0, (startTime - ctx.currentTime) * 1000));
    this.unsubTransport = transport.subscribe((snap) => {
      if (snap.state !== 'playing' && this.midi) void this.stop();
    });
  }

  /** Finish the MIDI take; `keep` = write the clip. */
  private endMidi(keep: boolean): void {
    const rec = this.midi;
    if (!rec) return;
    this.midi = null;
    rec.unsubInput();
    if (this.countInTimer) clearTimeout(this.countInTimer);
    this.unsubTransport?.();
    this.unsubTransport = null;
    set({ status: this.input ? 'ready' : 'idle' });
    if (!keep) return;
    const p = getProject();
    const track = p.tracks.find((t) => t.id === rec.trackId);
    if (!track) return;
    const endTick = this.heardTick(performance.now());
    const res = rec.take.finish(endTick, ticksPerBar(p.timeSignature));
    if (!res) {
      uiToast('info', 'No notes were played, so no MIDI clip was created.');
      return;
    }
    const takeNo = Object.values(p.clips).filter((c) => c.trackId === track.id && c.name.startsWith(`${track.name} take`)).length + 1;
    const clip = { ...createMidiClip(track.id, res.start, res.length), name: `${track.name} take ${takeNo}`, notes: res.notes };
    useProjectStore.getState().commit('Record MIDI', (prev) => ({ ...prev, clips: { ...prev.clips, [clip.id]: clip } }));
    useUiStore.getState().set({ selectedClipIds: [clip.id], selectedTrackId: track.id });
    uiToast('info', `Recorded ${res.notes.length} note${res.notes.length === 1 ? '' : 's'} into "${clip.name}".`);
  }

  async stop(): Promise<void> {
    if (this.midi) {
      this.endMidi(true);
      return;
    }
    const take = this.take;
    const inp = this.input;
    const ctx = engine.ctx;
    if (!take || !ctx) return;
    if (useRecordingStore.getState().status === 'finishing') return take.done;
    set({ status: 'finishing' });
    if (this.countInTimer) clearTimeout(this.countInTimer);
    this.unsubTransport?.();
    this.unsubTransport = null;
    const stopFrame = Math.max(Math.round(take.startTime * ctx.sampleRate), Math.round(ctx.currentTime * ctx.sampleRate));
    if (inp) {
      inp.node.port.postMessage({ type: 'stop', frame: stopFrame });
      // the worklet replies with 'done' once it passes stopFrame; don't hang if audio stopped running
      await Promise.race([take.done, new Promise((r) => setTimeout(r, 1500))]);
    }
    this.take = null;
    this.finalize(take);
    set({ status: this.input ? 'ready' : 'idle' });
  }

  /** Discard the current take (e.g. its track was deleted). */
  private abort(): void {
    const take = this.take;
    if (!take) return;
    this.take = null;
    this.unsubTransport?.();
    this.unsubTransport = null;
    this.input?.node.port.postMessage({ type: 'stop', frame: 0 });
    set({ status: this.input ? 'ready' : 'idle' });
  }

  private onWorkletMessage(m: { type: 'chunk'; l: Float32Array; r: Float32Array; frames: number } | { type: 'done'; frames: number }): void {
    const take = this.take;
    if (m.type === 'done') {
      take?.resolveDone();
      return;
    }
    if (take) {
      // keep our own copy so the worklet's buffers can be recycled
      const l = m.l.slice(0, m.frames);
      const r = m.r.slice(0, m.frames);
      take.chunks.push({ l, r, frames: m.frames });
      take.peaks.push(l, r, m.frames);
    }
    this.input?.node.port.postMessage({ type: 'recycle', l: m.l, r: m.r }, [m.l.buffer, m.r.buffer]);
  }

  private finalize(take: Take): void {
    const ctx = engine.ctx;
    if (!ctx) return;
    const [l, r] = assembleChunks(take.chunks);
    if (l.length < take.sampleRate * 0.05) {
      if (l.length > 0 || take.chunks.length === 0) uiToast('info', 'Recording was too short and was discarded.');
      return;
    }
    const buffer = ctx.createBuffer(2, l.length, take.sampleRate);
    buffer.copyToChannel(l, 0);
    buffer.copyToChannel(r, 1);
    const p = getProject();
    const track = p.tracks.find((t) => t.id === take.trackId);
    if (!track) return;
    const takeNo = Object.values(p.assets).filter((a) => a.name.startsWith(`${track.name} take`)).length + 1;
    const name = `${track.name} take ${takeNo}`;
    const bytes = encodeWav([l, r], take.sampleRate, { format: 'float32' });
    const asset = engine.assets.addBuffer(buffer, name, bytes, 'audio/wav');
    const place = placeRecordedClip(take.startTick, buffer.duration, take.latencySec, p.bpm);
    const clip = { ...createAudioClip(track.id, asset.ref.id, name, place.start, place.length), sourceOffset: place.sourceOffset };
    useProjectStore.getState().commit('Record audio', (prev) => ({
      ...prev,
      assets: { ...prev.assets, [asset.ref.id]: asset.ref },
      clips: { ...prev.clips, [clip.id]: clip },
    }));
    useUiStore.getState().set({ selectedClipIds: [clip.id], selectedTrackId: track.id });
  }

  /** Snapshot for drawing the growing waveform on the timeline. */
  liveView(): LiveRecordingView | null {
    const m = this.midi;
    if (m) return { kind: 'midi', trackId: m.trackId, startTick: m.take.startTick, notes: m.take.live() };
    const t = this.take;
    if (!t) return null;
    return { kind: 'audio', trackId: t.trackId, startTick: t.startTick, startTime: t.startTime, sampleRate: t.sampleRate, peaks: t.peaks };
  }
}

export const recorder = new AudioRecorder();
