import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Music, Repeat, Wand2 } from 'lucide-react';
import { DRUM_BASE_NOTE } from '../../drums/kit';
import { INSTRUMENTS, noteLabelFor } from '../../instruments/definitions';
import { chordToolActive } from '../../chords/expand';
import { chordLabel } from '../../chords/theory';
import { INSTRUMENT_UI } from '../instruments';
import { engine } from '../../audio/engine';
import { PPQ, SNAP_VALUES, isBlackKey, midiNoteName, snapToTicks, ticksPerBar, ticksPerBeatUnit, type SnapValue } from '../../core/time';
import {
  copyNotes,
  createNote,
  deleteNotes,
  fitClipToNotes,
  moveNotes,
  notesInRect,
  pasteNotes,
  quantizeNotes,
  resizeNotesTo,
  setVelocity,
} from '../../project/noteOps';
import type { MidiClip, MidiNote } from '../../project/types';
import { getProject, upsertClips, useProjectStore } from '../../state/projectStore';
import { useUiStore } from '../../state/uiStore';
import { importMidiIntoClip, togglePlay } from '../actions';
import { isMidiFileName } from '../../midi/smf';

const KEYS_W = 64;
const RULER_H = 20;
const VEL_H = 68;
const SB_H = 12;
const EDGE = 6;
const MIN_ROW = 6;
const MAX_ROW = 32;

type Drag =
  | { mode: 'move'; key: string; anchor: MidiNote; orig: MidiNote[]; ids: Set<string>; x: number; y: number; last: string; previewPitch: number }
  | { mode: 'resize'; key: string; anchor: MidiNote; orig: MidiNote[]; ids: Set<string>; last: string }
  | { mode: 'marquee'; t0: number; p0: number; t1: number; p1: number; base: Set<string> }
  | { mode: 'erase'; key: string }
  | { mode: 'keys'; pitch: number; id: number | null }
  | { mode: 'end'; key: string }
  | { mode: 'seek' }
  | { mode: 'pan'; x: number; y: number; sx: number; sy: number };

interface View {
  pxPerBeat: number;
  rowH: number;
  scrollX: number;
  scrollY: number;
}

let noteClipboard: { notes: MidiNote[]; span: number } | null = null;

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

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function PianoRoll({ clipId }: { clipId: string }) {
  const clip = useProjectStore((s) => s.project.clips[clipId]) as MidiClip | undefined;
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === clip?.trackId));
  const snap = useUiStore((s) => s.pianoSnap);
  const setUi = useUiStore((s) => s.set);
  const wrap = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const vel = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ pxPerBeat: 96, rowH: 14, scrollX: 0, scrollY: 0 });
  const sel = useRef<Set<string>>(new Set());
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);
  const lastLen = useRef(PPQ / 4); // new notes default to 1/16
  const [newVel, setNewVel] = useState(100);
  const [strength, setStrength] = useState(1);
  const [, force] = useState(0);
  const [size, setSize] = useState({ w: 800, h: 300 });
  const [midiDrop, setMidiDrop] = useState(false);
  const redraw = () => (dirty.current = true);
  // Space held = hand tool (drag to pan). A tap without dragging still toggles play.
  const spaceHeld = useRef(false);
  const panned = useRef(false);
  const sbThumb = useRef<HTMLDivElement>(null);
  const sbDrag = useRef<{ x: number; s: number } | null>(null);

  // ---- sizing ----
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const mainH = Math.max(80, size.h - VEL_H - SB_H);

  // center vertically on the clip's notes (or C4) when a clip opens
  useEffect(() => {
    const c = getProject().clips[clipId];
    const notes = c?.kind === 'midi' ? c.notes : [];
    const inst = getProject().tracks.find((t) => t.id === c?.trackId)?.instrument ?? null;
    const drums = noteLabelFor(inst, DRUM_BASE_NOTE) !== null;
    // drum racks: centre on the pad rows and default to short (1/16) hits
    const center = notes.length ? notes.reduce((a, n) => a + n.pitch, 0) / notes.length : drums ? DRUM_BASE_NOTE + 7.5 : 64;
    lastLen.current = PPQ / 4; // 1/16 by default for every instrument
    const v = view.current;
    v.scrollY = Math.max(0, (127 - center) * v.rowH - (mainH - RULER_H) / 2);
    v.scrollX = 0;
    sel.current = new Set();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  useEffect(() => {
    const u1 = useProjectStore.subscribe(redraw);
    const u2 = useUiStore.subscribe(redraw);
    return () => {
      u1();
      u2();
    };
  }, []);
  useEffect(() => void redraw(), [size.w, size.h]);

  // ---- coordinate helpers ----
  const grid = (): number => {
    const p = getProject();
    return snapToTicks(useUiStore.getState().pianoSnap, p.timeSignature);
  };
  const snapT = (t: number, bypass = false): number => {
    const g = grid();
    return bypass || g <= 0 ? Math.round(t) : Math.round(Math.round(t / g) * g);
  };
  const floorT = (t: number): number => {
    const g = grid();
    return g <= 0 ? Math.round(t) : Math.round(Math.floor(t / g) * g);
  };
  const tToX = (t: number) => KEYS_W + (t / PPQ) * view.current.pxPerBeat - view.current.scrollX;
  const xToT = (x: number) => ((x - KEYS_W + view.current.scrollX) / view.current.pxPerBeat) * PPQ;
  const pToY = (p: number) => RULER_H + (127 - p) * view.current.rowH - view.current.scrollY;
  const yToP = (y: number) => 127 - Math.floor((y - RULER_H + view.current.scrollY) / view.current.rowH);
  const clampScroll = () => {
    const v = view.current;
    v.scrollY = Math.min(Math.max(0, 128 * v.rowH - (mainH - RULER_H)), Math.max(0, v.scrollY));
    v.scrollX = Math.max(0, v.scrollX);
  };

  const latestClip = (): MidiClip | null => {
    const c = getProject().clips[clipId];
    return c && c.kind === 'midi' ? c : null;
  };
  /** Scrollable content width in px: clip plus two bars of headroom, never less than what's in view. */
  const contentPx = (): number => {
    const c = latestClip();
    const v = view.current;
    const bar = ticksPerBar(getProject().timeSignature);
    const len = ((c ? c.length : bar) + bar * 2) / PPQ * v.pxPerBeat;
    return Math.max(len, v.scrollX + (size.w - KEYS_W));
  };
  const cycleOf = (c: MidiClip) => (c.loop && c.loopLength > 0 ? c.loopLength : c.length);

  /** Commit new notes for the clip (non-looping clips grow to fit). */
  const commitNotes = (notes: MidiNote[], label: string, coalesce?: string) => {
    const c = latestClip();
    if (!c) return;
    const bar = ticksPerBar(getProject().timeSignature);
    const next = fitClipToNotes({ ...c, notes }, bar);
    upsertClips([next], label, coalesce ? { coalesce } : {});
  };

  const preview = (pitch: number, ms = 220) => {
    if (!track) return;
    const id = engine.previewNoteOn(track.id, pitch, newVel / 127);
    if (id !== null) setTimeout(() => engine.previewNoteOff(track.id, id), ms);
  };

  const hitNote = (c: MidiClip, x: number, y: number): { note: MidiNote; edge: boolean } | null => {
    const t = xToT(x);
    const p = yToP(y);
    const cycle = cycleOf(c);
    let found: { note: MidiNote; edge: boolean } | null = null;
    for (const n of c.notes) {
      if (n.pitch !== p || n.start >= cycle) continue;
      if (t < n.start || t > n.start + n.length) continue;
      const x1 = tToX(n.start + n.length);
      const edge = x1 - x < Math.min(EDGE, (x1 - tToX(n.start)) / 3);
      if (!found || sel.current.has(n.id)) found = { note: n, edge };
    }
    return found;
  };

  // ---- rendering ----
  useEffect(() => {
    let raf = 0;
    let lastPlay = -1;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const c = latestClip();
      const cv = main.current;
      const vc = vel.current;
      if (!c || !cv || !vc) return;
      const playTick = engine.transport?.getTick() ?? 0;
      if (!dirty.current && playTick === lastPlay) return;
      dirty.current = false;
      lastPlay = playTick;
      const project = getProject();
      const color = project.tracks.find((t) => t.id === c.trackId)?.color ?? '#9b8aff';
      const W = size.w;
      const H = mainH;
      const g = setupCanvas(cv, W, H);
      const gv = setupCanvas(vc, W, VEL_H);
      if (!g || !gv) return;
      const v = view.current;
      const cycle = cycleOf(c);
      const thumb = sbThumb.current;
      if (thumb) {
        const trackW = Math.max(1, W - KEYS_W);
        const total = contentPx();
        thumb.style.width = `${Math.max(24, (trackW * trackW) / total)}px`;
        thumb.style.left = `${(v.scrollX / total) * trackW}px`;
      }
      // rows
      g.fillStyle = '#0c0c13';
      g.fillRect(0, 0, W, H);
      const pTop = Math.min(127, yToP(RULER_H));
      const pBot = Math.max(0, yToP(H));
      const ownerTrack = project.tracks.find((t) => t.id === c.trackId);
      const inst = ownerTrack?.instrument ?? null;
      const labelOf = (p: number) => noteLabelFor(inst, p);
      // Gucci Slipper-izer: show which chord each key / note plays
      const chordCfg = chordToolActive(ownerTrack) ? ownerTrack.chords : null;
      const drumMode = labelOf(DRUM_BASE_NOTE) !== null;
      for (let p = pTop; p >= pBot; p--) {
        const y = pToY(p);
        g.fillStyle = drumMode ? (labelOf(p) !== null ? (p % 2 ? '#11111b' : '#141420') : '#08080c') : isBlackKey(p) ? '#0a0a10' : '#10101a';
        g.fillRect(KEYS_W, y, W - KEYS_W, v.rowH);
        g.fillStyle = p % 12 === 0 ? '#262638' : '#16161f';
        g.fillRect(KEYS_W, y + v.rowH - 1, W - KEYS_W, 1);
      }
      // vertical grid (aligned to absolute bars)
      const ts = project.timeSignature;
      const bar = ticksPerBar(ts);
      const beat = ticksPerBeatUnit(ts);
      let sub = Math.max(grid() || beat / 4, 1);
      while ((sub / PPQ) * v.pxPerBeat < 8) sub *= 2;
      const t0 = Math.max(0, xToT(KEYS_W));
      const t1 = xToT(W);
      for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) {
        const abs = c.start + t;
        const x = Math.round(tToX(t)) + 0.5;
        g.strokeStyle = abs % bar === 0 ? '#2e2e44' : abs % beat === 0 ? '#1f1f2e' : '#17171f';
        g.beginPath();
        g.moveTo(x, RULER_H);
        g.lineTo(x, H);
        g.stroke();
      }
      // regions beyond content / clip end
      const xCycle = tToX(cycle);
      const xEnd = tToX(c.length);
      if (c.loop && xCycle < xEnd) {
        g.fillStyle = 'rgba(8,8,14,0.45)';
        g.fillRect(Math.max(KEYS_W, xCycle), RULER_H, xEnd - Math.max(KEYS_W, xCycle), H - RULER_H);
      }
      g.fillStyle = 'rgba(4,4,8,0.62)';
      g.fillRect(Math.max(KEYS_W, xEnd), RULER_H, W, H - RULER_H);
      // ghost repeats of looped content
      if (c.loop && cycle > 0) {
        g.fillStyle = hexA(color, 0.22);
        for (let base = cycle; base < c.length; base += cycle) {
          for (const n of c.notes) {
            if (n.start >= cycle || base + n.start >= c.length) continue;
            const x = tToX(base + n.start);
            if (x > W) break;
            g.fillRect(x, pToY(n.pitch) + 1, Math.max(2, (Math.min(n.length, cycle - n.start) / PPQ) * v.pxPerBeat - 1), v.rowH - 2);
          }
        }
      }
      // notes
      g.font = `${Math.min(10, v.rowH - 3)}px Inter, system-ui, sans-serif`;
      g.textBaseline = 'middle';
      for (const n of c.notes) {
        const x = tToX(n.start);
        const w = Math.max(2, (n.length / PPQ) * v.pxPerBeat);
        const y = pToY(n.pitch);
        if (x > W || x + w < KEYS_W || y > H || y + v.rowH < RULER_H) continue;
        const selected = sel.current.has(n.id);
        const outside = n.start >= cycle;
        g.fillStyle = outside ? '#3a3a4a' : hexA(color, 0.45 + 0.55 * (n.velocity / 127));
        g.fillRect(x + 0.5, y + 1, w - 1, v.rowH - 2);
        g.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.5)';
        g.lineWidth = selected ? 1.5 : 1;
        g.strokeRect(x + 0.5, y + 1, w - 1, v.rowH - 2);
        g.lineWidth = 1;
        if (w > 28 && v.rowH >= 11) {
          g.fillStyle = 'rgba(10,10,16,0.85)';
          g.fillText(chordCfg ? chordLabel(chordCfg, n.pitch) : midiNoteName(n.pitch), x + 3, y + v.rowH / 2);
        }
      }
      // marquee
      const d = drag.current;
      if (d?.mode === 'marquee') {
        const ax = tToX(Math.min(d.t0, d.t1));
        const bx = tToX(Math.max(d.t0, d.t1));
        const ay = pToY(Math.max(d.p0, d.p1));
        const by = pToY(Math.min(d.p0, d.p1)) + v.rowH;
        g.fillStyle = 'rgba(155,138,255,0.12)';
        g.fillRect(ax, ay, bx - ax, by - ay);
        g.strokeStyle = '#9b8aff';
        g.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay);
      }
      // ruler
      g.fillStyle = '#101019';
      g.fillRect(KEYS_W, 0, W - KEYS_W, RULER_H);
      g.fillStyle = '#8b8ba6';
      g.font = '10px ui-monospace, Menlo, monospace';
      g.textBaseline = 'top';
      let labelStep = bar;
      while ((labelStep / PPQ) * v.pxPerBeat < 40) labelStep *= 2;
      const firstAbs = Math.floor((c.start + t0) / labelStep) * labelStep;
      for (let abs = firstAbs; abs <= c.start + t1; abs += labelStep) {
        const x = tToX(abs - c.start);
        if (x < KEYS_W) continue;
        g.fillRect(x, RULER_H - 6, 1, 6);
        g.fillText(String(Math.round(abs / bar) + 1), x + 3, 4);
      }
      // clip end / loop length handle
      const handleX = tToX(cycle);
      g.fillStyle = c.loop ? '#765dfc' : '#e8e8f2';
      g.beginPath();
      g.moveTo(handleX, RULER_H);
      g.lineTo(handleX - 6, RULER_H - 8);
      g.lineTo(handleX, RULER_H - 8);
      g.closePath();
      g.fill();
      g.fillRect(handleX - 1, 0, 2, RULER_H);
      g.fillStyle = '#262638';
      g.fillRect(KEYS_W, RULER_H - 1, W - KEYS_W, 1);
      // playhead (mapped into clip content, following clip loops)
      const rel = playTick - c.start;
      if (rel >= 0 && rel < c.length) {
        const pos = c.loop ? rel % cycle : rel;
        const px = Math.round(tToX(pos)) + 0.5;
        if (px >= KEYS_W) {
          g.strokeStyle = '#f5f5ff';
          g.beginPath();
          g.moveTo(px, 0);
          g.lineTo(px, H);
          g.stroke();
        }
      }
      // keyboard
      g.fillStyle = '#0a0a10';
      g.fillRect(0, 0, KEYS_W, H);
      const pressed = drag.current?.mode === 'keys' ? drag.current.pitch : -1;
      for (let p = pTop; p >= pBot; p--) {
        const y = pToY(p);
        const label = labelOf(p);
        if (label !== null) {
          // drum rack: rows are named pads instead of piano keys
          g.fillStyle = p === pressed ? '#fb923c' : '#1d1d2c';
          g.fillRect(0, y, KEYS_W - 1, v.rowH - 1);
          g.fillStyle = p === pressed ? '#0b0b12' : '#e8e8f2';
          g.font = `600 ${Math.min(10, v.rowH - 3)}px Inter, system-ui, sans-serif`;
          g.textBaseline = 'middle';
          let txt = label;
          while (txt.length > 1 && g.measureText(txt).width > KEYS_W - 8) txt = txt.slice(0, -1);
          g.fillText(txt, 4, y + v.rowH / 2);
          continue;
        }
        const black = isBlackKey(p);
        g.fillStyle = p === pressed ? '#9b8aff' : black ? '#1a1a24' : '#dcdce6';
        g.fillRect(black ? 0 : 0, y, black ? KEYS_W * 0.62 : KEYS_W - 1, v.rowH - (black ? 0 : 1));
        if (!black && (p % 12 === 0 || v.rowH >= 13)) {
          g.fillStyle = p % 12 === 0 ? '#22222e' : '#6a6a7a';
          g.font = `${p % 12 === 0 ? '600 ' : ''}${Math.min(10, v.rowH - 3)}px Inter, system-ui, sans-serif`;
          g.textBaseline = 'middle';
          g.fillText(midiNoteName(p), KEYS_W - 28, y + v.rowH / 2);
        }
        if (chordCfg && v.rowH >= 9) {
          g.fillStyle = black ? '#c4b5fd' : '#5b3fd6';
          g.font = `600 ${Math.min(9, v.rowH - 3)}px Inter, system-ui, sans-serif`;
          g.textBaseline = 'middle';
          let txt = chordLabel(chordCfg, p);
          while (txt.length > 1 && g.measureText(txt).width > (black ? KEYS_W * 0.6 : KEYS_W - 32)) txt = txt.slice(0, -1);
          g.fillText(txt, 3, y + v.rowH / 2);
        }
      }
      g.fillStyle = '#101019';
      g.fillRect(0, 0, KEYS_W, RULER_H);

      // velocity lane
      gv.fillStyle = '#0b0b11';
      gv.fillRect(0, 0, W, VEL_H);
      gv.fillStyle = '#101019';
      gv.fillRect(0, 0, KEYS_W, VEL_H);
      gv.fillStyle = '#5c5c74';
      gv.font = '9px Inter, system-ui, sans-serif';
      gv.textBaseline = 'middle';
      gv.fillText('VELOCITY', 8, VEL_H / 2);
      gv.fillStyle = '#1a1a28';
      gv.fillRect(KEYS_W, 0, W, 1);
      gv.fillRect(KEYS_W, VEL_H / 2, W, 1);
      for (const n of c.notes) {
        const x = tToX(n.start);
        if (x < KEYS_W - 4 || x > W) continue;
        const h = (n.velocity / 127) * (VEL_H - 8);
        const selected = sel.current.has(n.id);
        gv.fillStyle = selected ? '#ffffff' : hexA(color, 0.9);
        gv.fillRect(x, VEL_H - h - 2, 3, h);
        gv.beginPath();
        gv.arc(x + 1.5, VEL_H - h - 2, 2.5, 0, Math.PI * 2);
        gv.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, size.w, mainH]);

  // ---- main canvas interaction ----
  const local = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = latestClip();
    if (!c || !track) return;
    wrap.current?.focus();
    const { x, y } = local(e, e.currentTarget);
    e.currentTarget.setPointerCapture(e.pointerId);
    const key = `pr-${Date.now()}`;
    // hand tool: Space + drag, or middle mouse button
    if (spaceHeld.current || e.button === 1) {
      e.preventDefault();
      panned.current = true;
      drag.current = { mode: 'pan', x, y, sx: view.current.scrollX, sy: view.current.scrollY };
      e.currentTarget.style.cursor = 'grabbing';
      return;
    }
    // keyboard
    if (x < KEYS_W && y > RULER_H) {
      const pitch = yToP(y);
      const id = engine.previewNoteOn(track.id, pitch, newVel / 127);
      drag.current = { mode: 'keys', pitch, id };
      redraw();
      return;
    }
    // ruler: end handle or seek
    if (y <= RULER_H) {
      if (Math.abs(x - tToX(cycleOf(c))) < 8) drag.current = { mode: 'end', key };
      else {
        drag.current = { mode: 'seek' };
        engine.transport?.seek(c.start + Math.max(0, snapT(xToT(x), e.shiftKey)));
      }
      return;
    }
    if (e.button === 2) {
      drag.current = { mode: 'erase', key };
      const hit = hitNote(c, x, y);
      if (hit) commitNotes(deleteNotes(c.notes, new Set([hit.note.id])), 'Delete note', key);
      return;
    }
    if (e.button !== 0) return;
    const hit = hitNote(c, x, y);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) {
      const id = hit.note.id;
      if (!sel.current.has(id)) sel.current = additive ? new Set([...sel.current, id]) : new Set([id]);
      else if (additive && !hit.edge) {
        const s = new Set(sel.current);
        s.delete(id);
        sel.current = s;
        redraw();
        force((n) => n + 1);
        return;
      }
      let notes = c.notes;
      let anchor = hit.note;
      let ids = new Set(sel.current);
      if (e.altKey && !hit.edge) {
        // Alt-drag: duplicate selection, drag the copies
        const [all, pasted] = pasteNotes(c.notes, copyNotes(c.notes, ids), Math.min(...c.notes.filter((n) => ids.has(n.id)).map((n) => n.start)));
        notes = all;
        const map = new Map<string, string>();
        const origSel = c.notes.filter((n) => ids.has(n.id));
        origSel.forEach((n, i) => map.set(n.id, pasted[i] as string));
        ids = new Set(pasted);
        anchor = notes.find((n) => n.id === map.get(anchor.id)) ?? anchor;
        commitNotes(notes, 'Duplicate notes', key);
        sel.current = ids;
      }
      if (hit.edge) drag.current = { mode: 'resize', key, anchor, orig: notes, ids, last: '' };
      else {
        drag.current = { mode: 'move', key, anchor, orig: notes, ids, x, y, last: '', previewPitch: anchor.pitch };
        preview(anchor.pitch);
      }
    } else if (additive) {
      const t = xToT(x);
      const p = yToP(y);
      drag.current = { mode: 'marquee', t0: t, p0: p, t1: t, p1: p, base: e.shiftKey ? new Set(sel.current) : new Set() };
    } else {
      // place a new note and keep dragging it
      const t = floorT(Math.max(0, xToT(x)));
      const pitch = yToP(y);
      if (pitch < 0 || pitch > 127) return;
      const note = createNote(pitch, t, lastLen.current, newVel);
      const notes = [...c.notes, note];
      commitNotes(notes, 'Add note', key);
      sel.current = new Set([note.id]);
      drag.current = { mode: 'move', key, anchor: note, orig: notes, ids: new Set([note.id]), x, y, last: '0:0', previewPitch: pitch };
      preview(pitch);
    }
    redraw();
    force((n) => n + 1);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = latestClip();
    if (!c) return;
    const { x, y } = local(e, e.currentTarget);
    const d = drag.current;
    if (!d) {
      if (spaceHeld.current) e.currentTarget.style.cursor = 'grab';
      else if (x < KEYS_W) e.currentTarget.style.cursor = 'pointer';
      else if (y <= RULER_H) e.currentTarget.style.cursor = Math.abs(x - tToX(cycleOf(c))) < 8 ? 'ew-resize' : 'pointer';
      else {
        const hit = hitNote(c, x, y);
        e.currentTarget.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair';
      }
      return;
    }
    if (d.mode === 'pan') {
      view.current.scrollX = d.sx - (x - d.x);
      view.current.scrollY = d.sy - (y - d.y);
      clampScroll();
      redraw();
      return;
    }
    if (d.mode === 'keys') {
      const p = yToP(y);
      if (p !== d.pitch && track && p >= 0 && p <= 127) {
        if (d.id !== null) engine.previewNoteOff(track.id, d.id);
        drag.current = { mode: 'keys', pitch: p, id: engine.previewNoteOn(track.id, p, newVel / 127) };
        redraw();
      }
    } else if (d.mode === 'move') {
      const dt = snapT(d.anchor.start + (xToT(x) - xToT(d.x)), e.shiftKey) - d.anchor.start;
      const dp = yToP(y) - yToP(d.y);
      const sig = `${dt}:${dp}`;
      if (sig === d.last) return;
      d.last = sig;
      const notes = moveNotes(d.orig, d.ids, dt, dp);
      commitNotes(notes, 'Move notes', d.key);
      const newPitch = notes.find((n) => n.id === d.anchor.id)?.pitch ?? d.anchor.pitch;
      if (newPitch !== d.previewPitch) {
        d.previewPitch = newPitch;
        preview(newPitch, 150);
      }
    } else if (d.mode === 'resize') {
      const end = snapT(xToT(x), e.shiftKey);
      const g = grid();
      const notes = resizeNotesTo(d.orig, d.ids, d.anchor, Math.max(end, d.anchor.start + 1), e.shiftKey || g <= 0 ? 10 : g);
      const sig = notes.find((n) => n.id === d.anchor.id)?.length ?? 0;
      if (String(sig) === d.last) return;
      d.last = String(sig);
      lastLen.current = sig;
      commitNotes(notes, 'Resize notes', d.key);
    } else if (d.mode === 'marquee') {
      d.t1 = xToT(x);
      d.p1 = yToP(y);
      const ids = notesInRect(c.notes, d.t0, d.t1, d.p0, d.p1);
      sel.current = new Set([...d.base, ...ids]);
      redraw();
    } else if (d.mode === 'erase') {
      const hit = hitNote(c, x, y);
      if (hit) commitNotes(deleteNotes(c.notes, new Set([hit.note.id])), 'Delete note', d.key);
    } else if (d.mode === 'end') {
      const bar = ticksPerBar(getProject().timeSignature);
      const g = grid() || bar / 4;
      const len = Math.max(g, snapT(xToT(x), e.shiftKey));
      const next: MidiClip = c.loop ? { ...c, loopLength: Math.min(len, c.length) } : { ...c, length: len, loopLength: len };
      if (next.length !== c.length || next.loopLength !== c.loopLength) upsertClips([next], 'Clip length', { coalesce: d.key });
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'keys' && d.id !== null && track) engine.previewNoteOff(track.id, d.id);
    if (d?.mode === 'move') {
      const n = latestClip()?.notes.find((x) => x.id === d.anchor.id);
      if (n) lastLen.current = n.length;
    }
    redraw();
    force((n) => n + 1);
  };

  // ---- velocity lane ----
  const velDrag = useRef<string | null>(null);
  const paintVelocity = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = latestClip();
    if (!c || !velDrag.current) return;
    const { x, y } = local(e, e.currentTarget);
    const v = Math.round(((VEL_H - 2 - y) / (VEL_H - 8)) * 127);
    const hasSel = sel.current.size > 0;
    const hits = new Set(
      c.notes
        .filter((n) => (!hasSel || sel.current.has(n.id)) && Math.abs(tToX(n.start) + 1.5 - x) <= 5)
        .map((n) => n.id),
    );
    if (!hits.size) return;
    commitNotes(setVelocity(c.notes, hits, v), 'Velocity', velDrag.current);
  };

  // ---- wheel ----
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      const cv = main.current;
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const anchor = xToT(x);
        v.pxPerBeat = Math.min(800, Math.max(12, v.pxPerBeat * Math.exp(-e.deltaY * 0.0025)));
        v.scrollX = (anchor / PPQ) * v.pxPerBeat - (x - KEYS_W);
      } else if (e.altKey) {
        const p = yToP(y);
        v.rowH = Math.min(MAX_ROW, Math.max(MIN_ROW, v.rowH * Math.exp(-e.deltaY * 0.002)));
        v.scrollY = (127 - p) * v.rowH - (y - RULER_H);
      } else if (e.shiftKey) {
        v.scrollX += e.deltaY || e.deltaX;
      } else {
        v.scrollX += e.deltaX;
        v.scrollY += e.deltaY;
      }
      clampScroll();
      redraw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainH],
  );
  useEffect(() => {
    const cv = main.current;
    const vc = vel.current;
    cv?.addEventListener('wheel', onWheel, { passive: false });
    vc?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cv?.removeEventListener('wheel', onWheel);
      vc?.removeEventListener('wheel', onWheel);
    };
  }, [onWheel]);

  // ---- editing commands ----
  const doQuantize = () => {
    const c = latestClip();
    if (!c) return;
    const g = grid() || PPQ / 4;
    commitNotes(quantizeNotes(c.notes, sel.current.size ? sel.current : null, { grid: g, strength }), 'Quantize');
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (!spaceHeld.current) return;
    spaceHeld.current = false;
    if (main.current) main.current.style.cursor = 'crosshair';
    if (!panned.current) togglePlay();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      // handled on key-up so Space can double as a hand tool
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && !spaceHeld.current) {
        spaceHeld.current = true;
        panned.current = false;
        if (main.current && !drag.current) main.current.style.cursor = 'grab';
      }
      return;
    }
    const c = latestClip();
    if (!c) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
      redraw();
      force((n) => n + 1);
    };
    if (k === 'delete' || k === 'backspace') {
      if (sel.current.size) commitNotes(deleteNotes(c.notes, sel.current), 'Delete notes');
      sel.current = new Set();
      return handled();
    }
    if (mod && k === 'a') {
      sel.current = new Set(c.notes.map((n) => n.id));
      return handled();
    }
    if (mod && k === 'c') {
      noteClipboard = copyNotes(c.notes, sel.current);
      return handled();
    }
    if (mod && k === 'x') {
      noteClipboard = copyNotes(c.notes, sel.current);
      commitNotes(deleteNotes(c.notes, sel.current), 'Cut notes');
      sel.current = new Set();
      return handled();
    }
    if (mod && k === 'v') {
      if (noteClipboard?.notes.length) {
        const rel = (engine.transport?.getTick() ?? 0) - c.start;
        const selNotes = c.notes.filter((n) => sel.current.has(n.id));
        const at =
          rel >= 0 && rel < c.length && !engine.transport?.isPlaying()
            ? floorT(rel)
            : selNotes.length
              ? Math.max(...selNotes.map((n) => n.start + n.length))
              : 0;
        const [all, ids] = pasteNotes(c.notes, noteClipboard, at);
        commitNotes(all, 'Paste notes');
        sel.current = new Set(ids);
      }
      return handled();
    }
    if (mod && k === 'd') {
      if (sel.current.size) {
        const cp = copyNotes(c.notes, sel.current);
        const start = Math.min(...c.notes.filter((n) => sel.current.has(n.id)).map((n) => n.start));
        const g = grid() || PPQ / 4;
        const [all, ids] = pasteNotes(c.notes, cp, start + Math.ceil(cp.span / g) * g);
        commitNotes(all, 'Duplicate notes');
        sel.current = new Set(ids);
      }
      return handled();
    }
    if (!mod && (k === 'arrowup' || k === 'arrowdown')) {
      if (sel.current.size) {
        const d = (k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        commitNotes(moveNotes(c.notes, sel.current, 0, d), 'Transpose', `transpose-${clipId}`);
        const first = c.notes.find((n) => sel.current.has(n.id));
        if (first) preview(Math.min(127, Math.max(0, first.pitch + d)), 150);
      }
      return handled();
    }
    if (!mod && (k === 'arrowleft' || k === 'arrowright')) {
      if (sel.current.size) {
        const g = grid() || PPQ / 4;
        commitNotes(moveNotes(c.notes, sel.current, (k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 1 : g), 0), 'Nudge', `nudge-${clipId}`);
      }
      return handled();
    }
    if (!mod && k === 'q') {
      doQuantize();
      return handled();
    }
    if (k === 'escape') {
      sel.current = new Set();
      return handled();
    }
  };

  const zoom = (fx: number, fy: number) => {
    const v = view.current;
    const centerP = yToP(RULER_H + (mainH - RULER_H) / 2);
    v.pxPerBeat = Math.min(800, Math.max(12, v.pxPerBeat * fx));
    v.rowH = Math.min(MAX_ROW, Math.max(MIN_ROW, v.rowH * fy));
    v.scrollY = (127 - centerP) * v.rowH - (mainH - RULER_H) / 2;
    clampScroll();
    redraw();
  };

  if (!clip || clip.kind !== 'midi' || !track) return <div className="p-4 text-muted">Clip not found.</div>;
  const InstIcon = track.instrument ? INSTRUMENT_UI[track.instrument.type].icon : null;
  const nSel = sel.current.size;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2 text-[11px]">
        <Music size={13} className="text-muted" />
        <span className="font-medium text-fg">{clip.name}</span>
        <span className="text-dim">
          {clip.notes.length} notes{nSel ? ` · ${nSel} selected` : ''}
        </span>
        <div className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          title="Quantize selected notes (or all) to the snap grid (Q)"
          onClick={doQuantize}
          className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 hover:bg-line-2"
        >
          <Wand2 size={12} /> Quantize
        </button>
        <select value={strength} onChange={(e) => setStrength(Number(e.target.value))} title="Quantize strength">
          {[1, 0.75, 0.5, 0.25].map((s) => (
            <option key={s} value={s}>
              {Math.round(s * 100)}%
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-muted" title="Piano roll grid (snap and default note length). Hold Shift while dragging to bypass.">
          Grid
          <select value={snap} onChange={(e) => setUi({ pianoSnap: e.target.value as SnapValue })} className="h-6">
            {SNAP_VALUES.map((v) => (
              <option key={v} value={v}>
                {v === 'off' ? 'Off' : v === 'bar' ? 'Bar' : v}
              </option>
            ))}
          </select>
        </label>
        <div className="mx-1 h-4 w-px bg-line" />
        <label className="flex items-center gap-1 text-muted" title="Velocity for new notes and previews">
          Vel
          <input
            type="number"
            min={1}
            max={127}
            value={newVel}
            onChange={(e) => setNewVel(Math.min(127, Math.max(1, Number(e.target.value) || 100)))}
            className="h-6 w-12 rounded border border-line bg-base px-1 text-center font-mono text-fg outline-none"
          />
        </label>
        <button
          type="button"
          title="Loop the clip content (extend the clip in the arrangement to repeat it)"
          onClick={() => {
            const c = latestClip();
            if (c) upsertClips([{ ...c, loop: !c.loop, loopLength: c.loop ? c.length : c.loopLength || c.length }], c.loop ? 'Unloop clip' : 'Loop clip');
          }}
          className={`flex h-6 items-center gap-1 rounded px-2 ${clip.loop ? 'bg-accent text-white' : 'bg-panel-3 hover:bg-line-2'}`}
        >
          <Repeat size={12} /> Loop
        </button>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-dim">Zoom</span>
          <button type="button" className="h-5 w-5 rounded bg-panel-3 hover:bg-line-2" title="Zoom out horizontally (Ctrl+wheel)" onClick={() => zoom(1 / 1.4, 1)}>
            −
          </button>
          <button type="button" className="h-5 w-5 rounded bg-panel-3 hover:bg-line-2" title="Zoom in horizontally (Ctrl+wheel)" onClick={() => zoom(1.4, 1)}>
            +
          </button>
          <button type="button" className="h-5 w-5 rounded bg-panel-3 hover:bg-line-2" title="Shorter rows (Alt+wheel)" onClick={() => zoom(1, 1 / 1.25)}>
            ↕−
          </button>
          <button type="button" className="h-5 w-5 rounded bg-panel-3 hover:bg-line-2" title="Taller rows (Alt+wheel)" onClick={() => zoom(1, 1.25)}>
            ↕+
          </button>
          <div className="mx-1 h-4 w-px bg-line" />
          <button
            type="button"
            title={`Open this track's ${track.instrument ? INSTRUMENTS[track.instrument.type].label : 'instrument'}`}
            onClick={() => setUi({ synthTrackId: track.id })}
            className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 hover:bg-line-2"
          >
            {InstIcon && <InstIcon size={12} />} {track.instrument?.presetName ?? 'Instrument'}
          </button>
        </div>
      </div>
      <div
        ref={wrap}
        tabIndex={0}
        data-own-shortcuts
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => {
          spaceHeld.current = false;
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            setMidiDrop(true);
          }
        }}
        onDragLeave={() => setMidiDrop(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMidiDrop(false);
          const files = [...e.dataTransfer.files].filter((f) => isMidiFileName(f.name) || f.type === 'audio/midi' || f.type === 'audio/x-midi');
          if (!files.length) return;
          const cv = main.current;
          const x = cv ? e.clientX - cv.getBoundingClientRect().left : KEYS_W;
          // dropped where the pointer is (on the grid); over the keys: at the clip start
          let at = x > KEYS_W ? Math.max(0, floorT(xToT(x))) : 0;
          void (async () => {
            for (const f of files) {
              const ids = await importMidiIntoClip(f, clipId, at);
              if (ids.length) sel.current = new Set(ids);
              const c = latestClip();
              const added = c?.notes.filter((n) => ids.includes(n.id)) ?? [];
              if (added.length) at = Math.max(...added.map((n) => n.start + n.length));
            }
            redraw();
            force((n) => n + 1);
          })();
        }}
        className="relative min-h-0 flex-1 outline-none"
        title="Drop a .mid file here to add its notes · Click: add note · drag: move · drag right edge: resize · right-click: delete · Shift/Ctrl-drag: select · Alt-drag: duplicate · Space+drag or middle-drag: pan · wheel: scroll · Shift+wheel: scroll sideways"
      >
        <canvas
          ref={main}
          style={{ width: size.w, height: mainH }}
          className="block"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {midiDrop && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent/70 bg-accent/5 text-[12px] text-fg">
            Drop a MIDI file to add its notes here
          </div>
        )}
        <canvas
          ref={vel}
          style={{ width: size.w, height: VEL_H }}
          className="block cursor-ns-resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            velDrag.current = `vel-${Date.now()}`;
            paintVelocity(e);
          }}
          onPointerMove={paintVelocity}
          onPointerUp={() => (velDrag.current = null)}
          title="Drag to paint velocities (only selected notes when a selection exists)"
        />
        <div className="flex" style={{ height: SB_H }}>
          <div style={{ width: KEYS_W }} className="shrink-0 bg-panel" />
          <div
            className="relative flex-1 bg-panel"
            title="Scroll horizontally (or Shift+wheel / Space+drag)"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const trackW = Math.max(1, r.width);
              const total = contentPx();
              const thumbW = Math.max(24, (trackW * trackW) / total);
              const thumbX = (view.current.scrollX / total) * trackW;
              const x = e.clientX - r.left;
              if (x < thumbX || x > thumbX + thumbW) {
                view.current.scrollX = ((x - thumbW / 2) / trackW) * total;
                clampScroll();
                redraw();
              }
              e.currentTarget.setPointerCapture(e.pointerId);
              sbDrag.current = { x: e.clientX, s: view.current.scrollX };
            }}
            onPointerMove={(e) => {
              const d = sbDrag.current;
              if (!d) return;
              const trackW = Math.max(1, e.currentTarget.getBoundingClientRect().width);
              view.current.scrollX = d.s + ((e.clientX - d.x) / trackW) * contentPx();
              clampScroll();
              redraw();
            }}
            onPointerUp={() => (sbDrag.current = null)}
          >
            <div ref={sbThumb} data-testid="pr-hscroll-thumb" className="absolute top-[3px] h-[6px] rounded bg-line-2 hover:bg-dim" style={{ left: 0, width: 40 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
