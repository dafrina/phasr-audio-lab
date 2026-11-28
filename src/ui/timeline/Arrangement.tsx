import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { engine } from '../../audio/engine';
import { recorder } from '../../audio/recorder';
import { PPQ, ticksPerBar } from '../../core/time';
import { clipEnd, duplicateClip, moveClip, stretchAudioClip, trimClipEnd, trimClipStart } from '../../project/clipOps';
import { WARP_GOOD_MAX, WARP_GOOD_MIN, warpRate } from '../../audio/warp';
import { MAX_TRACKS, type AutomationLane, type AutomationPoint, type Clip, type Project } from '../../project/types';
import { segmentStarts, targetInfo, valueAt } from '../../project/automation';
import { curveAmountForMid, detent, handleX, isLinearShape, shapeAmount, shapeFrac, shapeLabel, type AutomationShape, type ShapeType } from '../../project/curves';
import { addLanePoint, deleteLanePoint, moveLanePoint, setLaneShapes } from '../../state/automationActions';
import type { NumericParamSpec } from '../../synth/params';
import { getProject, updateProjectFields, upsertClips, useProjectStore } from '../../state/projectStore';
import { useTransportStore } from '../../state/transportStore';
import { useUiStore } from '../../state/uiStore';
import {
  addNewTrack,
  renameClip,
  copySelectedClips,
  deleteSelectedClips,
  duplicateSelectedClips,
  importAudioFiles,
  importMidiFiles,
  exportClipMidi,
  NEW_TRACK,
  pasteClips,
  snapTick,
  splitSelectedAtPlayhead,
  toggleLoopSelectedClips,
  createMidiClipAt,
  openClipEditor,
} from '../actions';
import { isMidiFileName } from '../../midi/smf';
import { drawLanesDynamic, drawLanesStatic, drawRuler, drawRulerPlayhead, laneValueToY, laneYToValue, segmentHandle, type DrawState } from './draw';
import { EDGE_PX, HEADER_W, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT, RULER_H, TRACK_H, tickToX, xToTick } from './layout';
import { TrackHeader } from './TrackHeader';
import { AddTrackRow } from './AddTrackRow';
import { setTimeSelection } from './timeSelection';
import { getAutoSelection, setAutoHover, setAutoSelection, subscribeAutoSelection, type AutoSelection } from './autoSelection';
import { copyAutomation, cutAutomation, duplicateAutomation, pasteAutomation } from '../automationEdit';
import { hasPointClipboard } from '../../state/automationActions';
import { INSTRUMENT_TYPES, INSTRUMENTS } from '../../instruments/definitions';
import { ContextMenu, type MenuItem } from '../common/ContextMenu';

type Zone = 'body' | 'start' | 'end';

/** a press on a clip only becomes a drag after the pointer moves this far (a click changes nothing) */
const DRAG_PX = 3;
/** holding an audio clip's edge this long without moving turns the drag into a time-stretch */
export const STRETCH_HOLD_MS = 400;

type Drag =
  // `started`: past DRAG_PX; `copy`: Alt — the copies are made when the drag starts
  | { mode: 'move'; key: string; startX: number; startY: number; startTrack: number; origs: Clip[]; primary: Clip; last: string; started: boolean; copy: boolean }
  // `stretch`: held still on an audio clip's edge for STRETCH_HOLD_MS — the drag stretches instead of trimming
  | { mode: 'trim-start' | 'trim-end'; key: string; startX: number; orig: Clip; last: string; started: boolean; stretch: boolean; hold: ReturnType<typeof setTimeout> | null }
  | { mode: 'select'; startTick: number; startX: number; moved: boolean }
  | { mode: 'ruler'; startTick: number; startX: number; moved: boolean; key: string }
  | { mode: 'loop-edge'; edge: 'start' | 'end'; key: string }
  // `toggleOnClick`: Shift-press on a point — released without moving, it toggles the point in the selection
  | { mode: 'autopoint'; key: string; trackId: string; laneId: string; pointId: string; trackIndex: number; moved: boolean; toggleOnClick: AutoSelection | null; x0: number; y0: number }
  /**
   * bending a segment by its handle (or Alt-drag on the line): vertical = curve amount / S steepness,
   * sideways = an S's bend. `ax`/`ay`: the pointer movement so far (Shift scales new movement down);
   * `ya`/`yb`/`xa`/`wPx`: the segment on screen; `dotY`: the handle's y when the drag began
   */
  | { mode: 'curve'; key: string; trackId: string; laneId: string; pointId: string; start: AutomationShape | undefined; kind: 'curve' | 's'; lastX: number; lastY: number; ax: number; ay: number; xa: number; wPx: number; ya: number; yb: number; dotY: number }
  | { mode: 'automarquee'; trackId: string; laneId: string; trackIndex: number; x0: number; y0: number; base: string[] }
  | { mode: 'marquee'; x0: number; y0: number; base: string[] };

/** pixels of vertical drag for the full steepness range of an S (or a curve on a flat segment) */
const CURVE_DRAG_PX = 60;

/** the readout while stretching: speed, the tempo the audio now has, and the warnings */
function stretchLabel(rate: number, bpm: number, limited: boolean): string {
  const rough = rate < WARP_GOOD_MIN || rate > WARP_GOOD_MAX;
  return `Stretch ×${rate.toFixed(2)} · ${(bpm / rate).toFixed(1)} BPM${limited ? ' · limit 0.25×–4×' : rough ? ' · rough' : ''}`;
}

/** a clip's current playback rate (1 for MIDI / unwarped) */
function warpRateOf(c: Clip, bpm: number): number {
  return c.kind === 'audio' ? warpRate(c, bpm) : 1;
}

/** The automation lane being edited on the track under y (automation mode only). */
function editableLaneAt(project: Project, y: number) {
  const ui = useUiStore.getState();
  if (!ui.automationMode) return null;
  const trackIndex = Math.floor(y / TRACK_H);
  const track = project.tracks[trackIndex];
  if (!track) return null;
  const laneId = ui.shownLanes[track.id];
  const lane = track.automation.find((l) => l.id === laneId);
  const info = lane ? targetInfo(track, lane.target) : null;
  return lane && info ? { track, trackIndex, lane, spec: info.spec } : null;
}

function hitLanePoint(lane: AutomationLane, trackIndex: number, spec: NumericParamSpec, x: number, y: number, pxPerBeat: number, scrollX: number): AutomationPoint | null {
  let best: AutomationPoint | null = null;
  let bestD = 8;
  for (const p of lane.points) {
    const d = Math.hypot(tickToX(p.tick, pxPerBeat, scrollX) - x, laneValueToY(trackIndex, spec, p.value) - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** index of the segment (points[i] → points[i + 1]) under `tick`, or −1 */
function segmentAt(lane: AutomationLane, tick: number): number {
  const p = lane.points;
  for (let i = 0; i < p.length - 1; i++) if ((p[i] as AutomationPoint).tick <= tick && tick < (p[i + 1] as AutomationPoint).tick) return i;
  return -1;
}

/** the curve handle (of the given segments) under the pointer: the start point of its segment */
function hitHandle(lane: AutomationLane, trackIndex: number, spec: NumericParamSpec, ids: readonly string[], x: number, y: number, pxPerBeat: number, scrollX: number, r: number): string | null {
  let best: string | null = null;
  let bestD = r;
  for (const id of ids) {
    const i = lane.points.findIndex((p) => p.id === id);
    const at = i >= 0 ? segmentHandle(lane.points, i, spec, trackIndex, pxPerBeat, scrollX) : null;
    const d = at ? Math.hypot(at.x - x, at.y - y) : Infinity;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** the shape a segment's menu shows as current */
function shapeTypeOf(shape: AutomationShape | undefined): ShapeType {
  return !shape || (shape.type === 'curve' && isLinearShape(shape)) ? 'linear' : shape.type;
}

function hitClip(project: Project, x: number, y: number, pxPerBeat: number, scrollX: number): { clip: Clip; zone: Zone } | null {
  const ti = Math.floor(y / TRACK_H);
  const track = project.tracks[ti];
  if (!track) return null;
  const tick = xToTick(x, pxPerBeat, scrollX);
  let found: { clip: Clip; zone: Zone } | null = null;
  const sel = new Set(useUiStore.getState().selectedClipIds);
  for (const c of Object.values(project.clips)) {
    if (c.trackId !== track.id || tick < c.start || tick > clipEnd(c)) continue;
    const x0 = tickToX(c.start, pxPerBeat, scrollX);
    const x1 = tickToX(clipEnd(c), pxPerBeat, scrollX);
    const edge = Math.min(EDGE_PX, (x1 - x0) / 3);
    const zone: Zone = x - x0 < edge ? 'start' : x1 - x < edge ? 'end' : 'body';
    // prefer selected clips (they're drawn on top)
    if (!found || sel.has(c.id)) found = { clip: c, zone };
  }
  return found;
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 800, h: 400 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function setupCanvas(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d');
  g?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export function Arrangement() {
  const tracks = useProjectStore((s) => s.project.tracks);
  const selectedTrackId = useUiStore((s) => s.selectedTrackId);
  const scroller = useRef<HTMLDivElement>(null);
  const laneArea = useRef<HTMLDivElement>(null);
  const rulerCv = useRef<HTMLCanvasElement>(null);
  const laneCv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);
  /** offscreen cache of the static lane layer */
  const staticLayer = useRef<HTMLCanvasElement | null>(null);
  const rulerLayer = useRef<HTMLCanvasElement | null>(null);
  const timeSel = useRef<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dropHint, setDropHint] = useState(false);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** stretch mode on a clip edge: the highlighted edge and the live rate / tempo readout */
  const [stretchUi, setStretchUi] = useState<{ x: number; y: number; label: string } | null>(null);
  /** the readout while bending an automation segment ("Curve +40%") */
  const [curveUi, setCurveUi] = useState<{ x: number; y: number; label: string } | null>(null);
  /** the automation segment under the mouse (its handle shows) and whether the pointer is on the handle */
  const hoverSeg = useRef<{ laneId: string; pointId: string; onHandle: boolean } | null>(null);
  const { w: viewW } = useSize(laneArea);
  const { h: viewH } = useSize(scroller);
  const laneH = Math.max(viewH, tracks.length * TRACK_H + 48);

  // redraw whenever project/ui/assets change
  useEffect(() => {
    const mark = () => (dirty.current = true);
    const u1 = useProjectStore.subscribe(mark);
    const u2 = useUiStore.subscribe(mark);
    const u3 = engine.assets.subscribe(mark);
    const u4 = useTransportStore.subscribe(mark);
    const u5 = subscribeAutoSelection(mark);
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
    };
  }, []);
  useEffect(() => {
    dirty.current = true;
  }, [viewW, laneH]);

  /**
   * The curve handles a lane shows: the hovered segment's, the one being bent, and
   * those next to selected points (on touch there's no hover: tap a point to see them).
   */
  const visibleHandles = (lane: AutomationLane): { pointId: string; active: boolean }[] => {
    const out: { pointId: string; active: boolean }[] = [];
    const add = (pointId: string | undefined, active = false) => {
      if (!pointId) return;
      const have = out.find((h) => h.pointId === pointId);
      if (have) have.active ||= active;
      else out.push({ pointId, active });
    };
    const d = drag.current;
    if (d?.mode === 'curve' && d.laneId === lane.id) add(d.pointId, true);
    const hov = hoverSeg.current;
    if (hov && hov.laneId === lane.id && d === null) add(hov.pointId, hov.onHandle);
    const sel = getAutoSelection();
    if (sel && sel.laneId === lane.id) {
      for (const id of sel.ids) {
        const i = lane.points.findIndex((p) => p.id === id);
        if (i < 0) continue;
        add(lane.points[i]?.id);
        add(lane.points[i - 1]?.id);
      }
    }
    return out;
  };

  // render loop
  useEffect(() => {
    let raf = 0;
    let lastTick = -1;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const tr = engine.transport;
      const playTick = tr?.getTick() ?? 0;
      const playing = tr?.isPlaying() ?? false;
      const ui = useUiStore.getState();
      // follow the playhead by paging when it leaves the view
      if (playing && !drag.current) {
        const px = tickToX(playTick, ui.pxPerBeat, ui.scrollX);
        if (px > viewW - 24 || px < 0) {
          ui.set({ scrollX: Math.max(0, (playTick / PPQ) * ui.pxPerBeat - viewW * 0.1) });
        }
      }
      // `dirty` means the static layer (clips, grid, curves) must be repainted;
      // a moving playhead alone only repaints the cheap overlay.
      const staticDirty = dirty.current;
      if (!staticDirty && playTick === lastTick) return;
      dirty.current = false;
      lastTick = playTick;
      const project = useProjectStore.getState().project;
      const st: DrawState = {
        project,
        assets: engine.assets,
        pxPerBeat: ui.pxPerBeat,
        scrollX: ui.scrollX,
        selected: new Set(ui.selectedClipIds),
        playTick,
        timeSel: timeSel.current,
        selectedTrackId: ui.selectedTrackId,
        lanes: project.tracks.flatMap((t, trackIndex) => {
          const laneId = ui.shownLanes[t.id];
          const lane = laneId ? t.automation.find((l) => l.id === laneId) : undefined;
          const info = lane ? targetInfo(t, lane.target) : null;
          if (!lane || !info) return [];
          const cur = getAutoSelection();
          const sel = cur?.laneId === lane.id ? new Set(cur.ids) : undefined;
          return [{ trackIndex, points: lane.points, spec: info.spec, label: info.fullLabel, editable: ui.automationMode, enabled: lane.enabled, selected: ui.automationMode ? sel : undefined, handles: ui.automationMode ? visibleHandles(lane) : undefined }];
        }),
        recording: (() => {
          const live = recorder.liveView();
          if (!live) return null;
          const trackIndex = project.tracks.findIndex((t) => t.id === live.trackId);
          if (trackIndex < 0) return null;
          return live.kind === 'midi'
            ? { trackIndex, startTick: live.startTick, notes: live.notes }
            : { trackIndex, startTick: live.startTick, peaks: live.peaks, sampleRate: live.sampleRate };
        })(),
      };
      const rc = rulerCv.current;
      const lc = laneCv.current;
      if (rc) {
        // the ruler is cached like the lanes: only the playhead marker is drawn every frame
        const layer = (rulerLayer.current ??= document.createElement('canvas'));
        if (staticDirty || layer.width !== Math.round(viewW * (window.devicePixelRatio || 1))) {
          const sg = setupCanvas(layer, viewW, RULER_H);
          if (sg) drawRuler(sg, viewW, RULER_H, st);
        }
        const g = setupCanvas(rc, viewW, RULER_H);
        if (g) {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.drawImage(layer, 0, 0);
          const dpr = window.devicePixelRatio || 1;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawRulerPlayhead(g, viewW, st);
        }
      }
      if (lc) {
        const layer = (staticLayer.current ??= document.createElement('canvas'));
        if (staticDirty || layer.width !== Math.round(viewW * (window.devicePixelRatio || 1))) {
          const sg = setupCanvas(layer, viewW, laneH);
          if (sg) drawLanesStatic(sg, viewW, laneH, st);
        }
        const g = setupCanvas(lc, viewW, laneH);
        if (g) {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.drawImage(layer, 0, 0);
          const dpr = window.devicePixelRatio || 1;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawLanesDynamic(g, viewW, laneH, st);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [viewW, laneH]);

  const localPos = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ---------------- lanes ----------------

  /** Begin bending the segment that starts at `pointId` (its handle, or Alt-drag on the line). */
  const startCurveDrag = (al: NonNullable<ReturnType<typeof editableLaneAt>>, pointId: string, x: number, y: number, key: string) => {
    const ui = useUiStore.getState();
    const i = al.lane.points.findIndex((p) => p.id === pointId);
    const a = al.lane.points[i];
    const b = al.lane.points[i + 1];
    if (!a || !b || b.tick <= a.tick) return;
    const xa = tickToX(a.tick, ui.pxPerBeat, ui.scrollX);
    const ya = laneValueToY(al.trackIndex, al.spec, a.value);
    const yb = laneValueToY(al.trackIndex, al.spec, b.value);
    // (a hold bent by Alt-drag becomes a curve)
    const start = a.shape?.type === 'hold' ? undefined : a.shape;
    const dot = segmentHandle(al.lane.points, i, al.spec, al.trackIndex, ui.pxPerBeat, ui.scrollX) ?? { x: xa + (tickToX(b.tick, ui.pxPerBeat, ui.scrollX) - xa) / 2, y: (ya + yb) / 2 };
    drag.current = {
      mode: 'curve', key, trackId: al.track.id, laneId: al.lane.id, pointId, start, kind: start?.type === 's' ? 's' : 'curve',
      lastX: x, lastY: y, ax: 0, ay: 0, xa, wPx: Math.max(1, tickToX(b.tick, ui.pxPerBeat, ui.scrollX) - xa), ya, yb, dotY: dot.y,
    };
    setCurveUi({ x: dot.x, y: dot.y, label: shapeLabel(start) });
  };

  /** The shape a curve drag has reached (detents unless Shift; Shift also scales new movement down for fine control). */
  const bendTo = (d: Extract<Drag, { mode: 'curve' }>, x: number, y: number, fine: boolean): AutomationShape | undefined => {
    const f = fine ? 0.2 : 1;
    d.ax += (x - d.lastX) * f;
    d.ay += (y - d.lastY) * f;
    d.lastX = x;
    d.lastY = y;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    if (d.kind === 's') {
      const s0 = d.start?.type === 's' ? d.start : { steepness: 0, bend: 0.5 };
      let steepness = clamp(s0.steepness - d.ay / CURVE_DRAG_PX, -1, 1);
      let bend = clamp(s0.bend + d.ax / d.wPx, 0, 1);
      if (!fine) {
        steepness = detent(steepness);
        bend = detent(bend, 0.5, 0.02);
      }
      return { type: 's', steepness, bend };
    }
    // a curve's handle follows the pointer: the curve's midpoint goes where it is dragged
    const span = d.yb - d.ya;
    let amount = Math.abs(span) < 3 ? clamp(shapeAmount(d.start) - d.ay / CURVE_DRAG_PX, -1, 1) : curveAmountForMid((d.dotY + d.ay - d.ya) / span);
    if (!fine) amount = detent(amount);
    return amount === 0 ? undefined : { type: 'curve', amount };
  };

  /** Reset a segment's bend (double-click its handle): a curve → straight, an S → straight with its bend centred. */
  const resetCurve = (trackId: string, lane: AutomationLane, pointId: string) => {
    const a = lane.points.find((p) => p.id === pointId);
    setLaneShapes(trackId, lane.id, [pointId], a?.shape?.type === 's' ? { type: 's', steepness: 0, bend: 0.5 } : undefined);
  };

  const onLaneDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPos(e, e.currentTarget);
    const project = getProject();
    const ui = useUiStore.getState();
    e.currentTarget.setPointerCapture(e.pointerId);
    // automation mode: edit the shown lane's points instead of clips
    const al = editableLaneAt(project, y);
    if (al) {
      const key = `auto-${Date.now()}`;
      const lane = al.lane;
      ui.set({ selectedTrackId: al.track.id });
      dirty.current = true;
      // a curve handle: bend its segment
      const handle = hitHandle(lane, al.trackIndex, al.spec, visibleHandles(lane).map((h) => h.pointId), x, y, ui.pxPerBeat, ui.scrollX, 8);
      if (handle && !e.altKey) return void startCurveDrag(al, handle, x, y, key);
      const pt = hitLanePoint(lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
      if (pt) {
        if (e.altKey) return void deleteLanePoint(al.track.id, lane.id, pt.id);
        const cur = getAutoSelection();
        const sel = cur?.laneId === lane.id ? cur.ids : [];
        const toggled = { trackId: al.track.id, laneId: lane.id, ids: sel.includes(pt.id) ? sel.filter((i) => i !== pt.id) : [...sel, pt.id] };
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd-click: add to / remove from the selection
          setAutoSelection(toggled);
          return;
        }
        // (Shift: a click toggles the point in the selection; a drag moves it without snapping, as before)
        if (!e.shiftKey && !sel.includes(pt.id)) setAutoSelection({ trackId: al.track.id, laneId: lane.id, ids: [pt.id] });
        drag.current = { mode: 'autopoint', key, trackId: al.track.id, laneId: lane.id, pointId: pt.id, trackIndex: al.trackIndex, moved: false, toggleOnClick: e.shiftKey ? toggled : null, x0: x, y0: y };
        return;
      }
      const tick = xToTick(x, ui.pxPerBeat, ui.scrollX);
      // Alt-drag on the line itself bends that segment, like its handle
      if (e.altKey) {
        const i = segmentAt(lane, tick);
        const a = lane.points[i];
        if (a && Math.abs(laneValueToY(al.trackIndex, al.spec, valueAt(lane.points, tick, al.spec) as number) - y) <= 8) return void startCurveDrag(al, a.id, x, y, key);
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd-drag on empty lane space: box-select points
        const cur = getAutoSelection();
        drag.current = { mode: 'automarquee', trackId: al.track.id, laneId: lane.id, trackIndex: al.trackIndex, x0: x, y0: y, base: cur?.laneId === lane.id ? cur.ids : [] };
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        return;
      }
      const id = addLanePoint(al.track.id, lane.id, Math.max(0, snapTick(tick, e.shiftKey)), laneYToValue(al.trackIndex, al.spec, y), key);
      if (id) {
        setAutoSelection({ trackId: al.track.id, laneId: lane.id, ids: [id] });
        drag.current = { mode: 'autopoint', key, trackId: al.track.id, laneId: lane.id, pointId: id, trackIndex: al.trackIndex, moved: false, toggleOnClick: null, x0: x, y0: y };
      }
      return;
    }
    const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    timeSel.current = null;
    setTimeSelection(null);
    if (hit) {
      const id = hit.clip.id;
      let sel = ui.selectedClipIds;
      if (!sel.includes(id)) sel = additive ? [...sel, id] : [id];
      else if (additive && hit.zone === 'body' && !e.altKey) sel = sel.filter((s) => s !== id);
      ui.set({ selectedClipIds: sel, selectedTrackId: hit.clip.trackId });
      const key = `drag-${Date.now()}`;
      if (hit.zone === 'body') {
        let origs = sel.map((s) => project.clips[s]).filter((c): c is Clip => !!c);
        const primary = hit.clip;
        if (!origs.some((c) => c.id === primary.id)) origs = [primary];
        // (Alt-drag duplicates: the copies are made once the drag really starts — see onLaneMove)
        drag.current = { mode: 'move', key, startX: x, startY: y, startTrack: Math.floor(y / TRACK_H), origs, primary, last: '0:0', started: false, copy: e.altKey };
      } else {
        const d: Drag = { mode: hit.zone === 'start' ? 'trim-start' : 'trim-end', key, startX: x, orig: hit.clip, last: `${hit.clip.start}:${hit.clip.length}`, started: false, stretch: false, hold: null };
        drag.current = d;
        if (hit.clip.kind === 'audio') {
          // press and hold the edge (without moving) → stretch mode
          const canvas = e.currentTarget;
          const edgeTick = hit.zone === 'start' ? hit.clip.start : clipEnd(hit.clip);
          d.hold = setTimeout(() => {
            if (drag.current !== d || d.started) return;
            d.stretch = true;
            canvas.style.cursor = 'col-resize';
            setStretchUi({ x: tickToX(edgeTick, ui.pxPerBeat, ui.scrollX), y: Math.floor(y / TRACK_H) * TRACK_H, label: stretchLabel(warpRateOf(hit.clip, project.bpm), project.bpm, false) });
          }, STRETCH_HOLD_MS);
        }
      }
    } else if (additive) {
      // Ctrl/Shift-drag on empty space: box-select clips
      drag.current = { mode: 'marquee', x0: x, y0: y, base: e.shiftKey ? ui.selectedClipIds : [] };
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
    } else {
      const track = project.tracks[Math.floor(y / TRACK_H)];
      ui.set({ selectedClipIds: [], selectedTrackId: track?.id ?? ui.selectedTrackId });
      drag.current = { mode: 'select', startTick: xToTick(x, ui.pxPerBeat, ui.scrollX), startX: x, moved: false };
    }
    dirty.current = true;
  };

  const onLaneMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const project = getProject();
    const d = drag.current;
    if (!d) {
      const al = editableLaneAt(project, y);
      if (al) {
        // hovering a segment shows its curve handle
        const prev = hoverSeg.current;
        const i = segmentAt(al.lane, xToTick(x, ui.pxPerBeat, ui.scrollX));
        const seg = al.lane.points[i];
        const onHandle = !!seg && hitHandle(al.lane, al.trackIndex, al.spec, [seg.id], x, y, ui.pxPerBeat, ui.scrollX, 8) !== null;
        hoverSeg.current = seg ? { laneId: al.lane.id, pointId: seg.id, onHandle } : null;
        setAutoHover({ trackId: al.track.id, laneId: al.lane.id, tick: xToTick(x, ui.pxPerBeat, ui.scrollX) });
        if (prev?.pointId !== hoverSeg.current?.pointId || prev?.onHandle !== onHandle) dirty.current = true;
        const overPoint = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
        e.currentTarget.style.cursor = onHandle && !e.altKey ? (seg?.shape?.type === 's' ? 'move' : 'ns-resize') : overPoint ? 'move' : 'crosshair';
        return;
      }
      setAutoHover(null);
      if (hoverSeg.current) {
        hoverSeg.current = null;
        dirty.current = true;
      }
      const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
      e.currentTarget.style.cursor = !hit ? 'default' : hit.zone === 'body' ? 'grab' : 'ew-resize';
      return;
    }
    if (d.mode === 'marquee') {
      setMarquee({ x0: d.x0, y0: d.y0, x1: x, y1: y });
      const t0 = xToTick(Math.min(d.x0, x), ui.pxPerBeat, ui.scrollX);
      const t1 = xToTick(Math.max(d.x0, x), ui.pxPerBeat, ui.scrollX);
      const r0 = Math.floor(Math.min(d.y0, y) / TRACK_H);
      const r1 = Math.floor(Math.max(d.y0, y) / TRACK_H);
      const ids = project.tracks.slice(Math.max(0, r0), r1 + 1).map((t) => t.id);
      const hits = Object.values(project.clips)
        .filter((c) => ids.includes(c.trackId) && c.start < t1 && c.start + c.length > t0)
        .map((c) => c.id);
      ui.set({ selectedClipIds: [...new Set([...d.base, ...hits])] });
      return;
    }
    if (d.mode === 'curve') {
      const shape = bendTo(d, x, y, e.shiftKey);
      setLaneShapes(d.trackId, d.laneId, [d.pointId], shape, d.key);
      const hx = handleX(shape);
      setCurveUi({ x: d.xa + hx * d.wPx, y: d.ya + (d.yb - d.ya) * shapeFrac(shape, hx), label: shapeLabel(shape) });
      dirty.current = true;
      return;
    }
    if (d.mode === 'automarquee') {
      setMarquee({ x0: d.x0, y0: d.y0, x1: x, y1: y });
      const track = project.tracks[d.trackIndex];
      const lane = track?.automation.find((l) => l.id === d.laneId);
      const info = track && lane ? targetInfo(track, lane.target) : null;
      if (!lane || !info) return;
      const [x0, x1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
      const [y0, y1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
      const hits = lane.points
        .filter((p) => {
          const px = tickToX(p.tick, ui.pxPerBeat, ui.scrollX);
          const py = laneValueToY(d.trackIndex, info.spec, p.value);
          return px >= x0 && px <= x1 && py >= y0 && py <= y1;
        })
        .map((p) => p.id);
      setAutoSelection({ trackId: d.trackId, laneId: d.laneId, ids: [...new Set([...d.base, ...hits])] });
      dirty.current = true;
      return;
    }
    if (d.mode === 'autopoint') {
      const track = project.tracks.find((t) => t.id === d.trackId);
      const lane = track?.automation.find((l) => l.id === d.laneId);
      const info = track && lane ? targetInfo(track, lane.target) : null;
      if (!info) return;
      const tick = Math.max(0, snapTick(xToTick(x, ui.pxPerBeat, ui.scrollX), e.shiftKey));
      if (Math.hypot(x - d.x0, y - d.y0) > DRAG_PX) d.moved = true;
      moveLanePoint(d.trackId, d.laneId, d.pointId, tick, laneYToValue(d.trackIndex, info.spec, y), d.key);
      return;
    }
    const bypass = e.shiftKey && d.mode !== 'select';
    const tick = xToTick(x, ui.pxPerBeat, ui.scrollX);
    if ((d.mode === 'move' || d.mode === 'trim-start' || d.mode === 'trim-end') && !d.started) {
      // a click (or a hand wobbling a pixel) is not a drag: nothing moves, snaps or gets copied
      if (Math.abs(x - d.startX) <= DRAG_PX && (d.mode !== 'move' || Math.abs(y - d.startY) <= DRAG_PX)) return;
      d.started = true;
      // moved before the hold time: a trim
      if (d.mode !== 'move' && d.hold) clearTimeout(d.hold);
      if (d.mode === 'move' && d.copy) {
        // Alt-drag duplicates the selection and drags the copies
        const copies = d.origs.map((c) => duplicateClip(c, c.start));
        upsertClips(copies, 'Duplicate', { coalesce: d.key });
        const map = new Map(d.origs.map((c, i) => [c.id, copies[i] as Clip]));
        d.primary = map.get(d.primary.id) ?? d.primary;
        d.origs = copies;
        ui.set({ selectedClipIds: copies.map((c) => c.id) });
      }
    }
    if (d.mode === 'move') {
      e.currentTarget.style.cursor = 'grabbing';
      const dTick = tick - xToTick(d.startX, ui.pxPerBeat, ui.scrollX);
      let delta = snapTick(d.primary.start + dTick, bypass) - d.primary.start;
      const minStart = Math.min(...d.origs.map((c) => c.start));
      delta = Math.max(delta, -minStart);
      // vertical: move between compatible tracks
      let trackDelta = Math.floor(y / TRACK_H) - d.startTrack;
      const idx = new Map(project.tracks.map((t, i) => [t.id, i]));
      const ok = d.origs.every((c) => {
        const ti = (idx.get(c.trackId) ?? 0) + trackDelta;
        const t = project.tracks[ti];
        return t && (c.kind === 'audio' ? t.kind === 'audio' : t.kind === 'instrument');
      });
      if (!ok) trackDelta = 0;
      const sig = `${delta}:${trackDelta}`;
      if (sig === d.last) return;
      d.last = sig;
      const moved = d.origs.map((c) => {
        const ti = (idx.get(c.trackId) ?? 0) + trackDelta;
        return moveClip(c, c.start + delta, project.tracks[ti]?.id ?? c.trackId);
      });
      upsertClips(moved, 'Move clip', { coalesce: d.key });
    } else if ((d.mode === 'trim-start' || d.mode === 'trim-end') && d.stretch && d.orig.kind === 'audio') {
      // stretch: the other edge stays, the audio fills the new length (snaps like a trim; Shift: no snap)
      const r = stretchAudioClip(d.orig, d.mode === 'trim-start' ? 'start' : 'end', snapTick(tick, bypass), project.bpm);
      const edgeTick = d.mode === 'trim-start' ? r.clip.start : clipEnd(r.clip);
      setStretchUi((s) => s && { ...s, x: tickToX(edgeTick, ui.pxPerBeat, ui.scrollX), label: stretchLabel(r.rate, project.bpm, r.limited) });
      const sig = `${r.clip.start}:${r.clip.length}`;
      if (sig === d.last) return;
      d.last = sig;
      upsertClips([r.clip], 'Stretch clip', { coalesce: d.key });
    } else if (d.mode === 'trim-start' || d.mode === 'trim-end') {
      const t = snapTick(tick, bypass);
      const asset = d.orig.kind === 'audio' ? project.assets[d.orig.assetId] : undefined;
      const next =
        d.mode === 'trim-start' ? trimClipStart(d.orig, t, project.bpm) : trimClipEnd(d.orig, t, project.bpm, asset?.durationSec);
      const sig = `${next.start}:${next.length}`;
      if (sig === d.last) return;
      d.last = sig;
      upsertClips([next], 'Trim clip', { coalesce: d.key });
    } else if (d.mode === 'select') {
      if (Math.abs(x - d.startX) > 3) d.moved = true;
      if (d.moved) {
        const a = snapTick(d.startTick);
        const b = snapTick(tick);
        timeSel.current = a === b ? null : { start: Math.max(0, Math.min(a, b)), end: Math.max(a, b) };
        setTimeSelection(timeSel.current);
        dirty.current = true;
      }
    }
  };

  const onLaneUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && (d.mode === 'trim-start' || d.mode === 'trim-end') && d.hold) clearTimeout(d.hold);
    setStretchUi(null);
    e.currentTarget.style.cursor = 'default';
    if (d?.mode === 'marquee' || d?.mode === 'automarquee') setMarquee(null);
    if (d?.mode === 'curve') setCurveUi(null);
    if (d?.mode === 'autopoint' && !d.moved && d.toggleOnClick) setAutoSelection(d.toggleOnClick);
    if (d?.mode === 'select' && !d.moved) {
      // click on empty space moves the playhead
      engine.transport?.seek(snapTick(d.startTick));
    }
    dirty.current = true;
  };

  const onLaneDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const project = getProject();
    const al = editableLaneAt(project, y);
    if (al) {
      // a curve handle: back to straight
      const handle = hitHandle(al.lane, al.trackIndex, al.spec, visibleHandles(al.lane).map((h) => h.pointId), x, y, ui.pxPerBeat, ui.scrollX, 8);
      if (handle) return resetCurve(al.track.id, al.lane, handle);
      const pt = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
      if (pt) deleteLanePoint(al.track.id, al.lane.id, pt.id);
      return;
    }
    const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
    if (hit) return openClipEditor(hit.clip.id);
    const track = project.tracks[Math.floor(y / TRACK_H)];
    if (track?.kind === 'instrument') createMidiClipAt(track.id, xToTick(x, ui.pxPerBeat, ui.scrollX));
  };

  /**
   * The shape menu for the point or segment at (x, y): Linear / Curve / S-curve / Hold
   * for its segment — or, with several points selected around it, for every segment
   * between the first and last selected point — plus Delete on a point.
   */
  const shapeMenu = (al: NonNullable<ReturnType<typeof editableLaneAt>>, x: number, y: number): MenuItem[] | null => {
    const ui = useUiStore.getState();
    const lane = al.lane;
    const pt = hitLanePoint(lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
    const tick = xToTick(x, ui.pxPerBeat, ui.scrollX);
    const at = pt?.id ?? lane.points[segmentAt(lane, tick)]?.id;
    const was = getAutoSelection();
    // (a right-click / long-press on a point outside the selection selects it, for Copy / Cut)
    if (pt && !(was?.laneId === lane.id && was.ids.includes(pt.id))) setAutoSelection({ trackId: al.track.id, laneId: lane.id, ids: [pt.id] });
    const sel = getAutoSelection()?.laneId === lane.id ? (getAutoSelection()?.ids ?? []) : [];
    const edit: MenuItem[] = [
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !sel.length, onClick: () => void copyAutomation() },
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !sel.length, onClick: () => void cutAutomation() },
      { label: 'Paste here', shortcut: 'Ctrl+V', disabled: !hasPointClipboard(), onClick: () => void pasteAutomation({ trackId: al.track.id, laneId: lane.id, tick }) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !sel.length, onClick: () => void duplicateAutomation() },
    ];
    if (!at) return edit;
    const ids = segmentStarts(lane, at, sel);
    const cur = lane.points.find((p) => p.id === ids[0])?.shape;
    const type = shapeTypeOf(cur);
    const apply = (shape: AutomationShape | undefined) => () => {
      setLaneShapes(al.track.id, lane.id, ids, shape);
      dirty.current = true;
    };
    const items: MenuItem[] = [
      { label: ids.length > 1 ? `Shape of ${ids.length} segments` : 'Segment shape', disabled: true, onClick: () => {} },
      { label: 'Linear', checked: ids.length > 0 && type === 'linear', disabled: !ids.length, onClick: apply(undefined) },
      { label: 'Curve', checked: type === 'curve', disabled: !ids.length, onClick: apply(cur?.type === 'curve' ? cur : { type: 'curve', amount: 0.5 }) },
      { label: 'S-curve', checked: type === 's', disabled: !ids.length, onClick: apply(cur?.type === 's' ? cur : { type: 's', steepness: 0.5, bend: 0.5 }) },
      { label: 'Hold', checked: type === 'hold', disabled: !ids.length, onClick: apply({ type: 'hold' }) },
    ];
    items.push(...edit);
    if (pt) items.push({ label: 'Delete point', shortcut: 'Dbl-click', danger: true, onClick: () => deleteLanePoint(al.track.id, lane.id, pt.id) });
    return items;
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const al = editableLaneAt(getProject(), y);
    if (al) {
      const items = shapeMenu(al, x, y);
      if (items) setMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    const project = getProject();
    const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
    let items: MenuItem[];
    if (hit) {
      if (!ui.selectedClipIds.includes(hit.clip.id)) ui.set({ selectedClipIds: [hit.clip.id] });
      items = [
        { label: hit.clip.kind === 'midi' ? 'Open in piano roll' : 'Open in editor', shortcut: 'Dbl-click', onClick: () => openClipEditor(hit.clip.id) },
        { label: 'Rename…', onClick: () => renameClip(hit.clip.id) },
        ...(hit.clip.kind === 'midi' ? [{ label: 'Export as MIDI file (.mid)', onClick: () => exportClipMidi(hit.clip.id) }] : []),
        { label: 'Split at playhead', shortcut: 'Shift+S', onClick: splitSelectedAtPlayhead },
        { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: duplicateSelectedClips },
        { label: hit.clip.loop ? 'Stop looping content' : 'Loop content', shortcut: 'Ctrl+L', onClick: toggleLoopSelectedClips },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: copySelectedClips },
        { label: 'Delete', shortcut: 'Del', danger: true, onClick: deleteSelectedClips },
      ];
    } else {
      items = [
        { label: 'Paste at playhead', shortcut: 'Ctrl+V', onClick: pasteClips },
      ];
      const laneTrack = project.tracks[Math.floor(y / TRACK_H)];
      if (laneTrack?.kind === 'instrument') {
        const at = xToTick(x, ui.pxPerBeat, ui.scrollX);
        items.unshift({ label: 'New MIDI clip', shortcut: 'Dbl-click', onClick: () => createMidiClipAt(laneTrack.id, at) });
      }
      items = [
        ...items,
        { label: 'Add audio track', onClick: () => addNewTrack('audio'), disabled: project.tracks.length >= MAX_TRACKS },
        ...INSTRUMENT_TYPES.map((type) => ({ label: `Add ${INSTRUMENTS[type].label} track`, onClick: () => addNewTrack(type), disabled: project.tracks.length >= MAX_TRACKS })),
      ];
      if (timeSel.current) {
        const sel = timeSel.current;
        items.unshift({ label: 'Set loop to selection', shortcut: 'Shift+L', onClick: () => updateProjectFields('Set loop', { loop: { enabled: true, ...sel } }) });
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---------------- ruler ----------------

  const onRulerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const p = getProject();
    e.currentTarget.setPointerCapture(e.pointerId);
    const key = `loop-${Date.now()}`;
    // grab loop edges in the lower band
    if (y > RULER_H - 12) {
      const lx0 = tickToX(p.loop.start, ui.pxPerBeat, ui.scrollX);
      const lx1 = tickToX(p.loop.end, ui.pxPerBeat, ui.scrollX);
      if (Math.abs(x - lx0) < 6) return void (drag.current = { mode: 'loop-edge', edge: 'start', key });
      if (Math.abs(x - lx1) < 6) return void (drag.current = { mode: 'loop-edge', edge: 'end', key });
    }
    drag.current = { mode: 'ruler', startTick: xToTick(x, ui.pxPerBeat, ui.scrollX), startX: x, moved: false, key };
  };

  const onRulerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const p = getProject();
    const d = drag.current;
    const tick = Math.max(0, xToTick(x, ui.pxPerBeat, ui.scrollX));
    if (!d) {
      const lx0 = tickToX(p.loop.start, ui.pxPerBeat, ui.scrollX);
      const lx1 = tickToX(p.loop.end, ui.pxPerBeat, ui.scrollX);
      e.currentTarget.style.cursor = y > RULER_H - 12 && (Math.abs(x - lx0) < 6 || Math.abs(x - lx1) < 6) ? 'ew-resize' : 'pointer';
      return;
    }
    const grid = snapTick(tick, e.shiftKey);
    if (d.mode === 'loop-edge') {
      const min = 60;
      const loop =
        d.edge === 'start'
          ? { ...p.loop, start: Math.min(grid, p.loop.end - min) }
          : { ...p.loop, end: Math.max(grid, p.loop.start + min) };
      if (loop.start !== p.loop.start || loop.end !== p.loop.end) updateProjectFields('Loop region', { loop }, d.key);
    } else if (d.mode === 'ruler') {
      if (Math.abs(x - d.startX) > 4) d.moved = true;
      if (!d.moved) return;
      const a = snapTick(Math.max(0, d.startTick), e.shiftKey);
      if (a === grid) return;
      const loop = { enabled: true, start: Math.min(a, grid), end: Math.max(a, grid) };
      if (loop.start !== p.loop.start || loop.end !== p.loop.end || !p.loop.enabled) updateProjectFields('Loop region', { loop }, d.key);
    }
  };

  const onRulerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'ruler' && !d.moved) engine.transport?.seek(snapTick(Math.max(0, d.startTick), e.shiftKey));
  };

  // ---------------- wheel: zoom & horizontal scroll ----------------

  const onWheel = useCallback((e: WheelEvent) => {
    const el = laneArea.current;
    if (!el) return;
    const ui = useUiStore.getState();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left;
      const anchor = xToTick(x, ui.pxPerBeat, ui.scrollX);
      const px = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, ui.pxPerBeat * Math.exp(-e.deltaY * 0.0025)));
      ui.set({ pxPerBeat: px, scrollX: Math.max(0, (anchor / PPQ) * px - x) });
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      ui.set({ scrollX: Math.max(0, ui.scrollX + dx) });
    }
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    const rc = rulerCv.current;
    rc?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      rc?.removeEventListener('wheel', onWheel);
    };
  }, [onWheel]);

  // ---------------- file drop ----------------

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropHint(false);
    const all = [...e.dataTransfer.files];
    const midi = all.filter((f) => isMidiFileName(f.name) || f.type === 'audio/midi' || f.type === 'audio/x-midi');
    const files = all.filter((f) => !midi.includes(f) && (f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff)$/i.test(f.name)));
    if (!files.length && !midi.length) return;
    const cv = laneCv.current;
    if (!cv) return;
    const { x, y } = localPos(e, cv);
    const ui = useUiStore.getState();
    const track = getProject().tracks[Math.floor(y / TRACK_H)];
    const tick = snapTick(Math.max(0, xToTick(x, ui.pxPerBeat, ui.scrollX)));
    if (midi.length) void importMidiFiles(midi, { trackId: track?.kind === 'instrument' ? track.id : undefined, tick });
    if (files.length) void importAudioFiles(files, { trackId: track?.kind === 'audio' ? track.id : NEW_TRACK, tick });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-base">
      <div className="flex shrink-0" style={{ height: RULER_H }}>
        <div style={{ width: HEADER_W }} className="flex shrink-0 items-center justify-between border-b border-r border-line bg-panel px-2 text-[10px] uppercase tracking-wider text-muted">
          <span>Tracks {tracks.length}/{MAX_TRACKS}</span>
          <ZoomControls />
        </div>
        <canvas
          ref={rulerCv}
          style={{ width: viewW, height: RULER_H }}
          className="block"
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          title="Click to move the playhead · drag to set the loop region · drag loop edges to adjust"
        />
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex" style={{ minHeight: laneH }}>
          <div style={{ width: HEADER_W }} className="shrink-0 border-r border-line bg-panel">
            {tracks.map((t) => (
              <TrackHeader key={t.id} track={t} selected={t.id === selectedTrackId} />
            ))}
            <AddTrackRow count={tracks.length} />
          </div>
          <div
            ref={laneArea}
            className="relative min-w-0 flex-1"
            onDragOver={(e) => {
              if ([...e.dataTransfer.types].includes('Files')) {
                e.preventDefault();
                setDropHint(true);
              }
            }}
            onDragLeave={() => setDropHint(false)}
            onDrop={onDrop}
          >
            <canvas
              ref={laneCv}
              data-testid="lanes"
              style={{ width: viewW, height: laneH }}
              className="block"
              onPointerDown={onLaneDown}
              onPointerMove={onLaneMove}
              onPointerUp={onLaneUp}
              onPointerCancel={onLaneUp}
              onPointerLeave={() => {
                setAutoHover(null);
                if (hoverSeg.current && !drag.current) {
                  hoverSeg.current = null;
                  dirty.current = true;
                }
              }}
              onDoubleClick={onLaneDoubleClick}
              onContextMenu={onContextMenu}
            />
            {dropHint && <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent/70 bg-accent/5" />}
            {stretchUi && (
              <>
                <div data-testid="stretch-edge" className="pointer-events-none absolute w-[3px] bg-warn shadow-[0_0_8px_#facc15]" style={{ left: stretchUi.x - 1, top: stretchUi.y + 2, height: TRACK_H - 5 }} />
                <div data-testid="stretch-readout" className="pointer-events-none absolute whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-warn" style={{ left: stretchUi.x + 6, top: stretchUi.y + 4 }}>
                  {stretchUi.label}
                </div>
              </>
            )}
            {curveUi && (
              <div data-testid="curve-readout" className="pointer-events-none absolute whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-[#f472b6]" style={{ left: curveUi.x + 10, top: curveUi.y - 22 }}>
                {curveUi.label}
              </div>
            )}
            {marquee && (
              <div
                className="pointer-events-none absolute border border-accent-hi bg-accent/10"
                style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
              />
            )}
          </div>
        </div>
      </div>
      <HScrollbar viewW={viewW} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ZoomControls() {
  const px = useUiStore((s) => s.pxPerBeat);
  const set = useUiStore((s) => s.set);
  const zoom = (f: number) => {
    const ui = useUiStore.getState();
    const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, px * f));
    // keep the playhead roughly in place
    const t = engine.transport?.getTick() ?? 0;
    const x = tickToX(t, ui.pxPerBeat, ui.scrollX);
    set({ pxPerBeat: next, scrollX: Math.max(0, (t / PPQ) * next - x) });
  };
  return (
    <div className="flex items-center gap-0.5 normal-case">
      <button type="button" title="Zoom out (Ctrl+wheel)" className="h-4 w-4 rounded bg-panel-3 text-fg hover:bg-line-2" onClick={() => zoom(1 / 1.5)}>
        −
      </button>
      <button type="button" title="Zoom in (Ctrl+wheel)" className="h-4 w-4 rounded bg-panel-3 text-fg hover:bg-line-2" onClick={() => zoom(1.5)}>
        +
      </button>
    </div>
  );
}

function HScrollbar({ viewW }: { viewW: number }) {
  const scrollX = useUiStore((s) => s.scrollX);
  const px = useUiStore((s) => s.pxPerBeat);
  const project = useProjectStore((s) => s.project);
  const set = useUiStore((s) => s.set);
  const dragRef = useRef<{ x: number; s: number } | null>(null);
  const lastTick = Math.max(0, ...Object.values(project.clips).map(clipEnd), project.loop.end);
  const contentW = Math.max(viewW * 1.5, (lastTick / PPQ) * px + ticksPerBar(project.timeSignature) / PPQ * px * 16, scrollX + viewW);
  const thumbW = Math.max(30, (viewW / contentW) * viewW);
  const thumbX = (scrollX / contentW) * viewW;
  return (
    <div className="flex h-3 shrink-0 border-t border-line bg-panel">
      <div style={{ width: HEADER_W }} className="shrink-0 border-r border-line" />
      <div
        className="relative flex-1"
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - r.left;
          if (x < thumbX || x > thumbX + thumbW) set({ scrollX: Math.max(0, ((x - thumbW / 2) / viewW) * contentW) });
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, s: useUiStore.getState().scrollX };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          set({ scrollX: Math.max(0, d.s + ((e.clientX - d.x) / viewW) * contentW) });
        }}
        onPointerUp={() => (dragRef.current = null)}
      >
        <div className="absolute top-0.5 h-2 rounded bg-line-2 hover:bg-dim" style={{ left: thumbX, width: thumbW }} />
      </div>
    </div>
  );
}
