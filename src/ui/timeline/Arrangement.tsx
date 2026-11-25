import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { engine } from '../../audio/engine';
import { recorder } from '../../audio/recorder';
import { PPQ, ticksPerBar } from '../../core/time';
import { clipEnd, duplicateClip, moveClip, trimClipEnd, trimClipStart } from '../../project/clipOps';
import type { AutomationLane, AutomationPoint, Clip, Project } from '../../project/types';
import { targetInfo } from '../../project/automation';
import { addLanePoint, deleteLanePoint, moveLanePoint } from '../../state/automationActions';
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
  NEW_TRACK,
  pasteClips,
  snapTick,
  splitSelectedAtPlayhead,
  toggleLoopSelectedClips,
  createMidiClipAt,
  openClipEditor,
} from '../actions';
import { drawLanesDynamic, drawLanesStatic, drawRuler, laneValueToY, laneYToValue, type DrawState } from './draw';
import { EDGE_PX, HEADER_W, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT, RULER_H, TRACK_H, tickToX, xToTick } from './layout';
import { TrackHeader } from './TrackHeader';
import { AddTrackRow } from './AddTrackRow';
import { INSTRUMENT_TYPES, INSTRUMENTS } from '../../instruments/definitions';
import { ContextMenu, type MenuItem } from '../common/ContextMenu';

type Zone = 'body' | 'start' | 'end';

type Drag =
  | { mode: 'move'; key: string; startX: number; startTrack: number; origs: Clip[]; primary: Clip; last: string }
  | { mode: 'trim-start' | 'trim-end'; key: string; orig: Clip; last: string }
  | { mode: 'select'; startTick: number; startX: number; moved: boolean }
  | { mode: 'ruler'; startTick: number; startX: number; moved: boolean; key: string }
  | { mode: 'loop-edge'; edge: 'start' | 'end'; key: string }
  | { mode: 'autopoint'; key: string; trackId: string; laneId: string; pointId: string; trackIndex: number }
  | { mode: 'marquee'; x0: number; y0: number; base: string[] };

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
  const timeSel = useRef<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dropHint, setDropHint] = useState(false);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
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
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, []);
  useEffect(() => {
    dirty.current = true;
  }, [viewW, laneH]);

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
          return lane && info ? [{ trackIndex, points: lane.points, spec: info.spec, label: info.fullLabel, editable: ui.automationMode, enabled: lane.enabled }] : [];
        }),
        recording: (() => {
          const live = recorder.liveView();
          if (!live) return null;
          const trackIndex = project.tracks.findIndex((t) => t.id === live.trackId);
          return trackIndex < 0 ? null : { trackIndex, startTick: live.startTick, peaks: live.peaks, sampleRate: live.sampleRate };
        })(),
      };
      const rc = rulerCv.current;
      const lc = laneCv.current;
      if (rc) {
        const g = setupCanvas(rc, viewW, RULER_H);
        if (g) drawRuler(g, viewW, RULER_H, st);
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
      const pt = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
      ui.set({ selectedTrackId: al.track.id });
      if (pt) {
        if (e.altKey) return void deleteLanePoint(al.track.id, al.lane.id, pt.id);
        drag.current = { mode: 'autopoint', key, trackId: al.track.id, laneId: al.lane.id, pointId: pt.id, trackIndex: al.trackIndex };
      } else {
        const tick = Math.max(0, snapTick(xToTick(x, ui.pxPerBeat, ui.scrollX), e.shiftKey));
        const id = addLanePoint(al.track.id, al.lane.id, tick, laneYToValue(al.trackIndex, al.spec, y), key);
        if (id) drag.current = { mode: 'autopoint', key, trackId: al.track.id, laneId: al.lane.id, pointId: id, trackIndex: al.trackIndex };
      }
      dirty.current = true;
      return;
    }
    const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    timeSel.current = null;
    if (hit) {
      const id = hit.clip.id;
      let sel = ui.selectedClipIds;
      if (!sel.includes(id)) sel = additive ? [...sel, id] : [id];
      else if (additive && hit.zone === 'body' && !e.altKey) sel = sel.filter((s) => s !== id);
      ui.set({ selectedClipIds: sel, selectedTrackId: hit.clip.trackId });
      const key = `drag-${Date.now()}`;
      if (hit.zone === 'body') {
        let origs = sel.map((s) => project.clips[s]).filter((c): c is Clip => !!c);
        let primary = hit.clip;
        if (e.altKey) {
          // Alt-drag duplicates the selection and drags the copies
          const copies = origs.map((c) => duplicateClip(c, c.start));
          upsertClips(copies, 'Duplicate', { coalesce: key });
          const map = new Map(origs.map((c, i) => [c.id, copies[i] as Clip]));
          primary = map.get(primary.id) ?? primary;
          origs = copies;
          ui.set({ selectedClipIds: copies.map((c) => c.id) });
        }
        if (!origs.some((c) => c.id === primary.id)) origs = [primary];
        drag.current = { mode: 'move', key, startX: x, startTrack: Math.floor(y / TRACK_H), origs, primary, last: '' };
      } else {
        drag.current = { mode: hit.zone === 'start' ? 'trim-start' : 'trim-end', key, orig: hit.clip, last: '' };
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
        e.currentTarget.style.cursor = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX) ? 'move' : 'crosshair';
        return;
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
    if (d.mode === 'autopoint') {
      const track = project.tracks.find((t) => t.id === d.trackId);
      const lane = track?.automation.find((l) => l.id === d.laneId);
      const info = track && lane ? targetInfo(track, lane.target) : null;
      if (!info) return;
      const tick = Math.max(0, snapTick(xToTick(x, ui.pxPerBeat, ui.scrollX), e.shiftKey));
      moveLanePoint(d.trackId, d.laneId, d.pointId, tick, laneYToValue(d.trackIndex, info.spec, y), d.key);
      return;
    }
    const bypass = e.shiftKey && d.mode !== 'select';
    const tick = xToTick(x, ui.pxPerBeat, ui.scrollX);
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
        dirty.current = true;
      }
    }
  };

  const onLaneUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.style.cursor = 'default';
    if (d?.mode === 'marquee') setMarquee(null);
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
      const pt = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
      if (pt) deleteLanePoint(al.track.id, al.lane.id, pt.id);
      return;
    }
    const hit = hitClip(project, x, y, ui.pxPerBeat, ui.scrollX);
    if (hit) return openClipEditor(hit.clip.id);
    const track = project.tracks[Math.floor(y / TRACK_H)];
    if (track?.kind === 'instrument') createMidiClipAt(track.id, xToTick(x, ui.pxPerBeat, ui.scrollX));
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = localPos(e, e.currentTarget);
    const ui = useUiStore.getState();
    const al = editableLaneAt(getProject(), y);
    if (al) {
      const pt = hitLanePoint(al.lane, al.trackIndex, al.spec, x, y, ui.pxPerBeat, ui.scrollX);
      if (pt) deleteLanePoint(al.track.id, al.lane.id, pt.id);
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
        { label: 'Split at playhead', shortcut: 'S', onClick: splitSelectedAtPlayhead },
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
        { label: 'Add audio track', onClick: () => addNewTrack('audio'), disabled: project.tracks.length >= 8 },
        ...INSTRUMENT_TYPES.map((type) => ({ label: `Add ${INSTRUMENTS[type].label} track`, onClick: () => addNewTrack(type), disabled: project.tracks.length >= 8 })),
      ];
      if (timeSel.current) {
        const sel = timeSel.current;
        items.unshift({ label: 'Set loop to selection', shortcut: 'L', onClick: () => updateProjectFields('Set loop', { loop: { enabled: true, ...sel } }) });
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
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|aif|aiff)$/i.test(f.name));
    if (!files.length) return;
    const cv = laneCv.current;
    if (!cv) return;
    const { x, y } = localPos(e, cv);
    const ui = useUiStore.getState();
    const track = getProject().tracks[Math.floor(y / TRACK_H)];
    const tick = snapTick(Math.max(0, xToTick(x, ui.pxPerBeat, ui.scrollX)));
    void importAudioFiles(files, { trackId: track?.kind === 'audio' ? track.id : NEW_TRACK, tick });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-base">
      <div className="flex shrink-0" style={{ height: RULER_H }}>
        <div style={{ width: HEADER_W }} className="flex shrink-0 items-center justify-between border-b border-r border-line bg-panel px-2 text-[10px] uppercase tracking-wider text-muted">
          <span>Tracks {tracks.length}/8</span>
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
              onDoubleClick={onLaneDoubleClick}
              onContextMenu={onContextMenu}
            />
            {dropHint && <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent/70 bg-accent/5" />}
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
