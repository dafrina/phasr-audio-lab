/**
 * Capture, live: the engine's live note input (Web MIDI, computer keys,
 * on-screen keys, drum pads — not an editor auditioning a note) goes into the
 * capture buffer with the tick heard at that moment, always; captureNow()
 * turns the last bars of it into a MIDI clip (one undo step, a toast).
 * Pure logic in capture.ts.
 */
import { engine } from './engine';
import { CaptureBuffer, CAPTURE_SECONDS, barMs, buildCapture, freeBarFrom, type CaptureResult } from './capture';
import { PPQ, ticksPerBar } from '../core/time';
import { createMidiClip } from '../project/defaults';
import { getProject, useProjectStore } from '../state/projectStore';
import { uiToast, useUiStore } from '../state/uiStore';

export const captureBuffer = new CaptureBuffer();
let started = false;

/** Start filling the buffer (once, at app start). */
export function startCapture(): void {
  if (started) return;
  started = true;
  const tickAt = (at: number) => (engine.transport?.isPlaying() ? engine.heardTick(at) : Number.NaN);
  engine.onLiveInput((e) => {
    if (e.type === 'noteOn') {
      if (e.audition) return;
      captureBuffer.noteOn(e.trackId, e.id, e.note, e.velocity, e.at, tickAt(e.at));
    } else if (e.type === 'noteOff') captureBuffer.noteOff(e.trackId, e.id, e.at, tickAt(e.at));
    else captureBuffer.sustain(e.trackId, e.on, e.at, tickAt(e.at));
  });
  // a deleted track's notes go with it
  useProjectStore.subscribe((s, prev) => {
    if (s.project.tracks === prev.project.tracks) return;
    const ids = new Set(s.project.tracks.map((t) => t.id));
    for (const t of prev.project.tracks) if (!ids.has(t.id)) captureBuffer.drop(t.id);
  });
}

/** The longest capture, in bars, at the project's tempo (the buffer's minute). */
export function maxCaptureBars(): number {
  const p = getProject();
  return Math.max(1, Math.floor((CAPTURE_SECONDS * 1000) / barMs({ bpm: p.bpm, barTicks: ticksPerBar(p.timeSignature), ppq: PPQ })));
}

export interface CapturePlan {
  trackId: string;
  trackName: string;
  result: CaptureResult;
  /** where the clip would start */
  start: number;
}

/** What Capture would take right now from the last instrument track played (null: nothing). */
export function planCapture(bars: number, nowMs = performance.now()): CapturePlan | null {
  const p = getProject();
  const trackId = captureBuffer.lastTrackId;
  const track = p.tracks.find((t) => t.id === trackId && t.kind === 'instrument');
  if (!track) return null;
  const transport = engine.transport;
  const playing = !!transport?.isPlaying();
  const barTicks = ticksPerBar(p.timeSignature);
  const result = buildCapture(captureBuffer.events(track.id, nowMs), {
    nowMs,
    bars: Math.min(maxCaptureBars(), Math.max(1, Math.round(bars))),
    bpm: p.bpm,
    barTicks,
    ppq: PPQ,
    nowTick: playing ? engine.heardTick(nowMs) : null,
    loop: p.loop.enabled && p.loop.end > p.loop.start ? { start: p.loop.start, end: p.loop.end } : null,
  });
  if (!result) return null;
  const start =
    result.mode === 'timeline'
      ? result.start
      : freeBarFrom(
          Object.values(p.clips).filter((c) => c.trackId === track.id),
          transport?.getTick() ?? 0,
          result.length,
          barTicks,
        );
  return { trackId: track.id, trackName: track.name, result, start };
}

/** Turn the last `bars` bars played into a MIDI clip. Returns the new clip's id. */
export function captureNow(bars: number): string | null {
  const plan = planCapture(bars);
  if (!plan) {
    uiToast('info', 'Nothing to capture yet: play something on an instrument track first (the last minute is kept).');
    return null;
  }
  const p = getProject();
  const { result, trackId, trackName } = plan;
  const n = Object.values(p.clips).filter((c) => c.trackId === trackId && c.name.startsWith(`${trackName} capture`)).length + 1;
  const clip = { ...createMidiClip(trackId, plan.start, result.length), name: `${trackName} capture ${n}`, notes: result.notes };
  useProjectStore.getState().commit('Capture MIDI', (prev) => ({ ...prev, clips: { ...prev.clips, [clip.id]: clip } }));
  useUiStore.getState().set({ selectedClipIds: [clip.id], selectedTrackId: trackId });
  const barsLen = Math.round(result.length / ticksPerBar(p.timeSignature));
  const where = result.mode === 'timeline' ? 'where you played them' : `at bar ${Math.floor(plan.start / ticksPerBar(p.timeSignature)) + 1}`;
  uiToast('info', `Captured ${result.notes.length} note${result.notes.length === 1 ? '' : 's'} into "${clip.name}" (${barsLen} bar${barsLen === 1 ? '' : 's'}, ${where}).`);
  return clip.id;
}
