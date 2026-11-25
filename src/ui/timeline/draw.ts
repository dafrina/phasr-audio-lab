/**
 * Canvas rendering for the arrangement ruler and lanes. Pure drawing functions:
 * all inputs come in through DrawState, so they can be called every frame.
 */
import { PPQ, ticksPerBar, ticksPerBeatUnit, ticksToSeconds } from '../../core/time';
import { audioSourcePosition } from '../../audio/scheduling';
import { peakRange, pickLevel } from '../../audio/peaks';
import type { AssetRegistry } from '../../audio/assets';
import type { AudioClip, AutomationPoint, Clip, MidiClip, Project } from '../../project/types';
import { fromNormalized, toNormalized, type NumericParamSpec } from '../../synth/params';
import { valueAt } from '../../project/automation';
import { TRACK_H, tickToX } from './layout';
import { LIVE_PEAK_BUCKET, type LivePeaks } from '../../audio/recordingMath';

export interface DrawState {
  project: Project;
  assets: AssetRegistry;
  pxPerBeat: number;
  scrollX: number;
  selected: ReadonlySet<string>;
  playTick: number;
  timeSel: { start: number; end: number } | null;
  selectedTrackId: string | null;
  /** take in progress, drawn as a growing red clip */
  recording: { trackIndex: number; startTick: number; peaks: LivePeaks; sampleRate: number } | null;
  /** automation lanes shown over their tracks */
  lanes: { trackIndex: number; points: AutomationPoint[]; spec: NumericParamSpec; label: string; editable: boolean; enabled: boolean }[];
}

/** Vertical area of a track used for automation curves. */
export function laneBox(trackIndex: number): { top: number; h: number } {
  return { top: trackIndex * TRACK_H + 17, h: TRACK_H - 23 };
}

export function laneValueToY(trackIndex: number, spec: NumericParamSpec, v: number): number {
  const { top, h } = laneBox(trackIndex);
  return top + (1 - Math.min(1, Math.max(0, toNormalized(spec, v)))) * h;
}

export function laneYToValue(trackIndex: number, spec: NumericParamSpec, y: number): number {
  const { top, h } = laneBox(trackIndex);
  return fromNormalized(spec, 1 - (y - top) / h);
}

const COL = {
  bg: '#0c0c13',
  laneAlt: '#0e0e16',
  laneSel: '#13131e',
  bar: '#2a2a3d',
  beat: '#1c1c2a',
  sub: '#15151f',
  text: '#8b8ba6',
  playhead: '#f5f5ff',
  loop: '#765dfc',
  loopOff: '#3a3a52',
  sel: 'rgba(118,93,252,0.12)',
};

/** Choose grid steps so that lines are not denser than ~10 px. */
export function gridSteps(project: Project, pxPerBeat: number): { sub: number; beat: number; bar: number; label: number } {
  const bar = ticksPerBar(project.timeSignature);
  const beat = ticksPerBeatUnit(project.timeSignature);
  const pxPerTick = pxPerBeat / PPQ;
  let sub = beat / 4;
  while (sub * pxPerTick < 10 && sub < bar) sub *= 2;
  let label = bar;
  while (label * pxPerTick < 48) label *= 2;
  return { sub: Math.min(sub, bar), beat, bar, label };
}

function visibleTickRange(width: number, s: DrawState): [number, number] {
  const t0 = (s.scrollX / s.pxPerBeat) * PPQ;
  const t1 = ((s.scrollX + width) / s.pxPerBeat) * PPQ;
  return [t0, t1];
}

function drawGrid(g: CanvasRenderingContext2D, width: number, height: number, s: DrawState): void {
  const { sub, beat, bar } = gridSteps(s.project, s.pxPerBeat);
  const [t0, t1] = visibleTickRange(width, s);
  const first = Math.floor(t0 / sub) * sub;
  for (let t = first; t <= t1; t += sub) {
    const x = Math.round(tickToX(t, s.pxPerBeat, s.scrollX)) + 0.5;
    const isBar = Math.abs(t % bar) < 1e-6;
    const isBeat = Math.abs(t % beat) < 1e-6;
    g.strokeStyle = isBar ? COL.bar : isBeat ? COL.beat : COL.sub;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
  }
}

export function drawRuler(g: CanvasRenderingContext2D, width: number, height: number, s: DrawState): void {
  g.fillStyle = '#101019';
  g.fillRect(0, 0, width, height);
  const { label, bar, beat } = gridSteps(s.project, s.pxPerBeat);
  const [t0, t1] = visibleTickRange(width, s);
  // loop region band
  const lp = s.project.loop;
  const lx0 = tickToX(lp.start, s.pxPerBeat, s.scrollX);
  const lx1 = tickToX(lp.end, s.pxPerBeat, s.scrollX);
  g.fillStyle = lp.enabled ? 'rgba(118,93,252,0.35)' : 'rgba(90,90,120,0.22)';
  g.fillRect(lx0, height - 10, lx1 - lx0, 10);
  g.fillStyle = lp.enabled ? COL.loop : COL.loopOff;
  g.fillRect(lx0, height - 10, 2, 10);
  g.fillRect(lx1 - 2, height - 10, 2, 10);
  // ticks
  g.font = '10px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  const tickStep = beat * (s.pxPerBeat < 14 ? 4 : 1);
  for (let t = Math.floor(t0 / tickStep) * tickStep; t <= t1; t += tickStep) {
    const x = Math.round(tickToX(t, s.pxPerBeat, s.scrollX)) + 0.5;
    const isBar = Math.abs(t % bar) < 1e-6;
    g.strokeStyle = isBar ? '#4a4a64' : '#2a2a3d';
    g.beginPath();
    g.moveTo(x, isBar ? height - 14 : height - 7);
    g.lineTo(x, height);
    g.stroke();
  }
  g.fillStyle = COL.text;
  for (let t = Math.floor(t0 / label) * label; t <= t1; t += label) {
    const x = tickToX(t, s.pxPerBeat, s.scrollX);
    g.fillText(String(Math.round(t / bar) + 1), x + 3, 3);
  }
  // time selection
  if (s.timeSel) {
    const a = tickToX(s.timeSel.start, s.pxPerBeat, s.scrollX);
    const b = tickToX(s.timeSel.end, s.pxPerBeat, s.scrollX);
    g.fillStyle = 'rgba(232,232,242,0.15)';
    g.fillRect(a, 0, b - a, height - 10);
  }
  // playhead marker
  const px = tickToX(s.playTick, s.pxPerBeat, s.scrollX);
  if (px >= -6 && px <= width + 6) {
    g.fillStyle = COL.playhead;
    g.beginPath();
    g.moveTo(px - 5, 0);
    g.lineTo(px + 5, 0);
    g.lineTo(px + 5, 6);
    g.lineTo(px, 11);
    g.lineTo(px - 5, 6);
    g.closePath();
    g.fill();
  }
  g.fillStyle = '#262638';
  g.fillRect(0, height - 1, width, 1);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

const peakOut: [number, number] = [0, 0];

function drawAudioContent(g: CanvasRenderingContext2D, clip: AudioClip, x0: number, x1: number, top: number, h: number, width: number, s: DrawState, color: string): void {
  const asset = s.assets.get(clip.assetId);
  if (!asset) {
    g.fillStyle = '#f43f5e';
    g.font = '10px sans-serif';
    g.fillText('missing audio', x0 + 4, top + h / 2);
    return;
  }
  const bpm = s.project.bpm;
  const sr = asset.peaks.sampleRate;
  const secPerPx = ticksToSeconds(PPQ / s.pxPerBeat, bpm);
  const level = pickLevel(asset.peaks, secPerPx * sr);
  const mid = top + h / 2;
  const amp = (h / 2) * 0.92 * Math.min(2, clip.gain);
  g.fillStyle = color;
  const from = Math.max(Math.floor(x0), 0);
  const to = Math.min(Math.ceil(x1), width);
  for (let x = from; x < to; x++) {
    const relSec = (x - x0) * secPerPx;
    const pos = audioSourcePosition(clip, relSec);
    const f0 = pos * sr;
    const f1 = f0 + secPerPx * sr;
    if (f0 >= asset.peaks.frames) continue;
    peakRange(level, f0, f1, peakOut);
    const y0 = mid - peakOut[1] * amp;
    const y1 = mid - peakOut[0] * amp;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function drawMidiContent(g: CanvasRenderingContext2D, clip: MidiClip, x0: number, top: number, h: number, s: DrawState, color: string, clipRight: number): void {
  if (!clip.notes.length) return;
  let lo = 127;
  let hi = 0;
  for (const n of clip.notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  const range = Math.max(12, hi - lo + 1);
  const center = (lo + hi) / 2;
  lo = center - range / 2;
  const noteH = Math.max(1.5, Math.min(5, h / range));
  const pxPerTick = s.pxPerBeat / PPQ;
  const cycle = clip.loop && clip.loopLength > 0 ? clip.loopLength : clip.length;
  g.fillStyle = color;
  for (let base = 0; base < clip.length; base += cycle) {
    for (const n of clip.notes) {
      if (n.start >= cycle) continue;
      const st = base + n.start;
      if (st >= clip.length) continue;
      const nx = x0 + st * pxPerTick;
      if (nx > clipRight) break;
      const nw = Math.max(1, Math.min(n.length, cycle - n.start, clip.length - st) * pxPerTick - 1);
      const ny = top + h - ((n.pitch - lo + 0.5) / range) * h - noteH / 2;
      g.fillRect(nx, ny, Math.min(nw, clipRight - nx), noteH);
    }
  }
}

export function drawClip(g: CanvasRenderingContext2D, clip: Clip, trackIndex: number, color: string, width: number, s: DrawState): void {
  const x0 = tickToX(clip.start, s.pxPerBeat, s.scrollX);
  const x1 = tickToX(clip.start + clip.length, s.pxPerBeat, s.scrollX);
  if (x1 < -2 || x0 > width + 2) return;
  const y = trackIndex * TRACK_H + 2;
  const h = TRACK_H - 5;
  const w = Math.max(2, x1 - x0);
  const selected = s.selected.has(clip.id);
  g.save();
  roundRect(g, x0 + 0.5, y + 0.5, w - 1, h, 4);
  g.fillStyle = hexA(color, selected ? 0.32 : 0.2);
  g.fill();
  g.clip();
  // header strip
  g.fillStyle = hexA(color, selected ? 0.95 : 0.75);
  g.fillRect(x0, y, w, 14);
  g.fillStyle = '#0b0b12';
  g.font = '600 10px Inter, system-ui, sans-serif';
  g.textBaseline = 'middle';
  const label = clip.loop ? `⟳ ${clip.name}` : clip.name;
  g.fillText(label, Math.max(x0, 0) + 4, y + 7.5);
  const bodyTop = y + 15;
  const bodyH = h - 17;
  const content = hexA(lighten(color), 0.9);
  if (clip.kind === 'audio') drawAudioContent(g, clip, x0, x1, bodyTop, bodyH, width, s, content);
  else drawMidiContent(g, clip, x0, bodyTop + 2, bodyH - 4, s, content, x1);
  // loop boundaries
  if (clip.loop) {
    const cycleTicks =
      clip.kind === 'midi'
        ? clip.loopLength
        : (clip.loopSeconds * s.project.bpm * PPQ) / 60;
    if (cycleTicks > 0) {
      const phaseTicks = clip.kind === 'audio' ? (clip.loopStartPhase * s.project.bpm * PPQ) / 60 : 0;
      g.strokeStyle = hexA('#ffffff', 0.35);
      g.setLineDash([3, 3]);
      for (let t = cycleTicks - phaseTicks; t < clip.length; t += cycleTicks) {
        if (t <= 0) continue;
        const lx = Math.round(x0 + (t * s.pxPerBeat) / PPQ) + 0.5;
        g.beginPath();
        g.moveTo(lx, bodyTop);
        g.lineTo(lx, y + h);
        g.stroke();
      }
      g.setLineDash([]);
    }
  }
  g.restore();
  roundRect(g, x0 + 0.5, y + 0.5, w - 1, h, 4);
  g.lineWidth = selected ? 1.5 : 1;
  g.strokeStyle = selected ? '#ffffff' : hexA(color, 0.9);
  g.stroke();
  g.lineWidth = 1;
}

/** Everything on the lanes (both layers). */
export function drawLanes(g: CanvasRenderingContext2D, width: number, height: number, s: DrawState): void {
  drawLanesStatic(g, width, height, s);
  drawLanesDynamic(g, width, height, s);
}

/**
 * The part of the lanes that only changes when the project, view or selection
 * changes (grid, clips, waveforms, notes, automation curves). The arrangement
 * caches this layer and repaints it only when needed — not on every frame of
 * playback.
 */
export function drawLanesStatic(g: CanvasRenderingContext2D, width: number, height: number, s: DrawState): void {
  g.fillStyle = COL.bg;
  g.fillRect(0, 0, width, height);
  const tracks = s.project.tracks;
  tracks.forEach((t, i) => {
    g.fillStyle = t.id === s.selectedTrackId ? COL.laneSel : i % 2 ? COL.laneAlt : COL.bg;
    g.fillRect(0, i * TRACK_H, width, TRACK_H);
  });
  drawGrid(g, width, height, s);
  // loop region tint
  const lp = s.project.loop;
  if (lp.enabled) {
    const a = tickToX(lp.start, s.pxPerBeat, s.scrollX);
    const b = tickToX(lp.end, s.pxPerBeat, s.scrollX);
    g.fillStyle = 'rgba(118,93,252,0.05)';
    g.fillRect(a, 0, b - a, tracks.length * TRACK_H);
  }
  g.fillStyle = '#1a1a28';
  for (let i = 1; i <= tracks.length; i++) g.fillRect(0, i * TRACK_H - 1, width, 1);
  // clips: unselected first so selected ones draw on top
  const index = new Map(tracks.map((t, i) => [t.id, i]));
  const clips = Object.values(s.project.clips);
  for (const pass of [false, true]) {
    for (const c of clips) {
      if (s.selected.has(c.id) !== pass) continue;
      const i = index.get(c.trackId);
      if (i === undefined) continue;
      drawClip(g, c, i, tracks[i]?.color ?? '#888', width, s);
    }
  }
  for (const lane of s.lanes) drawLane(g, width, s, lane);
  if (s.timeSel) {
    const a = tickToX(s.timeSel.start, s.pxPerBeat, s.scrollX);
    const b = tickToX(s.timeSel.end, s.pxPerBeat, s.scrollX);
    g.fillStyle = 'rgba(232,232,242,0.07)';
    g.fillRect(a, 0, b - a, height);
    g.fillStyle = 'rgba(232,232,242,0.4)';
    g.fillRect(Math.round(a), 0, 1, height);
    g.fillRect(Math.round(b), 0, 1, height);
  }
  // empty-area hint
  if (tracks.length < 8) {
    g.fillStyle = '#3c3c55';
    g.font = '11px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('Drop audio files here to create a new track', 12, tracks.length * TRACK_H + 22);
  }
}

/** Per-frame overlay: the take being recorded, live automation values and the playhead. */
export function drawLanesDynamic(g: CanvasRenderingContext2D, width: number, height: number, s: DrawState): void {
  if (s.recording && s.playTick > s.recording.startTick) drawLiveRecording(g, s, s.recording);
  for (const lane of s.lanes) drawLaneLabel(g, width, s, lane);
  const px = Math.round(tickToX(s.playTick, s.pxPerBeat, s.scrollX)) + 0.5;
  if (px >= 0 && px <= width) {
    g.strokeStyle = COL.playhead;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, height);
    g.stroke();
  }
}

const AUTO_COLOR = '#f472b6';

function drawLane(g: CanvasRenderingContext2D, width: number, s: DrawState, lane: DrawState['lanes'][number]): void {
  const { top, h } = laneBox(lane.trackIndex);
  const alpha = lane.editable ? 1 : 0.45;
  g.save();
  if (lane.editable) {
    g.fillStyle = 'rgba(8,8,13,0.45)';
    g.fillRect(0, top - 2, width, h + 4);
  }
  g.globalAlpha = lane.enabled ? alpha : alpha * 0.5;
  g.strokeStyle = AUTO_COLOR;
  g.lineWidth = 1.6;
  if (!lane.enabled) g.setLineDash([4, 3]);
  g.beginPath();
  const pts = lane.points;
  if (pts.length) {
    const yAt = (v: number) => laneValueToY(lane.trackIndex, lane.spec, v);
    g.moveTo(0, yAt(valueAt(pts, (s.scrollX / s.pxPerBeat) * PPQ) as number));
    for (const p of pts) g.lineTo(tickToX(p.tick, s.pxPerBeat, s.scrollX), yAt(p.value));
    g.lineTo(width, yAt((pts[pts.length - 1] as AutomationPoint).value));
    g.stroke();
    g.setLineDash([]);
    for (const p of pts) {
      const x = tickToX(p.tick, s.pxPerBeat, s.scrollX);
      if (x < -6 || x > width + 6) continue;
      g.beginPath();
      g.arc(x, yAt(p.value), lane.editable ? 4 : 2.5, 0, Math.PI * 2);
      g.fillStyle = lane.editable ? '#0b0b12' : AUTO_COLOR;
      g.fill();
      g.stroke();
    }
  }
  g.restore();
}

/** The lane's name and its value at the playhead (changes every frame while playing). */
function drawLaneLabel(g: CanvasRenderingContext2D, width: number, s: DrawState, lane: DrawState['lanes'][number]): void {
  const { top } = laneBox(lane.trackIndex);
  g.save();
  const v = valueAt(lane.points, s.playTick);
  const txt = `${lane.label}${v !== null ? `: ${lane.spec.format(v)}` : ''}${lane.enabled ? '' : ' (off)'}`;
  g.globalAlpha = 1;
  g.font = '600 10px Inter, system-ui, sans-serif';
  g.textBaseline = 'top';
  const tw = g.measureText(txt).width;
  g.fillStyle = 'rgba(8,8,13,0.75)';
  g.fillRect(width - tw - 12, top, tw + 8, 14);
  g.fillStyle = AUTO_COLOR;
  g.fillText(txt, width - tw - 8, top + 2);
  g.restore();
}

function drawLiveRecording(g: CanvasRenderingContext2D, s: DrawState, rec: NonNullable<DrawState['recording']>): void {
  const x0 = tickToX(rec.startTick, s.pxPerBeat, s.scrollX);
  const x1 = tickToX(s.playTick, s.pxPerBeat, s.scrollX);
  const y = rec.trackIndex * TRACK_H + 2;
  const h = TRACK_H - 5;
  g.save();
  roundRect(g, x0 + 0.5, y + 0.5, Math.max(2, x1 - x0 - 1), h, 4);
  g.fillStyle = 'rgba(244,63,94,0.22)';
  g.fill();
  g.strokeStyle = '#f43f5e';
  g.stroke();
  g.clip();
  g.fillStyle = 'rgba(244,63,94,0.9)';
  g.fillRect(x0, y, x1 - x0, 14);
  g.fillStyle = '#ffffff';
  g.font = '600 10px Inter, system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.fillText('● REC', Math.max(x0, 0) + 4, y + 7.5);
  // waveform from the live peak list
  const secPerPx = ticksToSeconds(PPQ / s.pxPerBeat, s.project.bpm);
  const bucketsPerPx = (secPerPx * rec.sampleRate) / LIVE_PEAK_BUCKET;
  const mid = y + 15 + (h - 17) / 2;
  const amp = (h - 17) / 2;
  g.fillStyle = '#fda4af';
  const n = rec.peaks.min.length;
  for (let x = Math.max(0, Math.floor(x0)); x < x1; x++) {
    const b0 = Math.floor((x - x0) * bucketsPerPx);
    if (b0 >= n) break;
    const b1 = Math.min(n, Math.max(b0 + 1, Math.floor((x + 1 - x0) * bucketsPerPx)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      lo = Math.min(lo, rec.peaks.min[b] as number);
      hi = Math.max(hi, rec.peaks.max[b] as number);
    }
    g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
  g.restore();
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function lighten(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  const r = mix((n >> 16) & 255);
  const gg = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
}
