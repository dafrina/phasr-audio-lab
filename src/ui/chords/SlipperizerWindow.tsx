/**
 * Gucci Slipper-izer window: pick a vibe and key, then play single keys —
 * every key plays a full chord (or, in auto-play, the whole progression).
 * Built for people who don't know music theory: chords are shown as pads
 * on the keys that trigger them, and everything can be auditioned by click.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Footprints, Power, Wand2, X } from 'lucide-react';
import { engine } from '../../audio/engine';
import { bakeChords, chordToolActive } from '../../chords/expand';
import { VIBES, chordAtSlot, keyName, noteName, vibeById, type ChordPattern, type ChordToolConfig } from '../../chords/theory';
import { getProject, updateTrack, useProjectStore } from '../../state/projectStore';
import { uiToast, useUiStore } from '../../state/uiStore';
import { Knob } from '../common/Knob';
import { KeyboardStrip, useComputerKeyboard } from '../synth/KeyboardStrip';
import type { NumericParamSpec } from '../../synth/params';
import { useWindowZ } from '../common/windowStack';
import { DanglingSlippers } from './DanglingSlippers';

const WIN_W = 940;
const GOLD = '#d9b44a';
const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
/** black keys: pitch class and the white-key slot they spice */
const BLACK_KEYS: { pc: number; slot: number; after: number }[] = [
  { pc: 1, slot: 0, after: 0 },
  { pc: 3, slot: 1, after: 1 },
  { pc: 6, slot: 3, after: 3 },
  { pc: 8, slot: 4, after: 4 },
  { pc: 10, slot: 5, after: 5 },
];
const PATTERNS: { id: ChordPattern; label: string; hint: string }[] = [
  { id: 'hold', label: 'Hold', hint: 'Each chord rings for its full length' },
  { id: 'stabs', label: 'Stabs', hint: 'Short repeated chord hits at the chosen rate' },
  { id: 'offbeat', label: 'Offbeat', hint: 'Classic house organ: chords on every "and"' },
  { id: 'syncopated', label: 'Groove', hint: 'A syncopated dance rhythm' },
  { id: 'arp', label: 'Arp', hint: 'Chord notes one after another, up and down' },
];
const STRUM_SPEC: NumericParamSpec = { label: 'Strum', min: 0, max: 1, default: 0, curve: 'linear', format: (v) => (v < 0.01 ? 'Off' : `${Math.round(v * 100)}%`) };

export function SlipperizerWindow({ trackId }: { trackId: string }) {
  const win = useWindowZ('chords');
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === trackId));
  const clipCount = useProjectStore((s) => Object.values(s.project.clips).filter((c) => c.trackId === trackId && c.kind === 'midi').length);
  const setUi = useUiStore((s) => s.set);
  const root = useRef<HTMLDivElement>(null);
  const [winH, setWinH] = useState(400);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWinH(el.offsetHeight));
    ro.observe(el);
    setWinH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  const [pos, setPos] = useState(() => ({ x: Math.max(8, (window.innerWidth - WIN_W) / 2), y: Math.max(56, window.innerHeight - 640) }));
  const dragWin = useRef<{ dx: number; dy: number } | null>(null);
  const [padDown, setPadDown] = useState<number | null>(null);
  const padNote = useRef<number | null>(null);

  const close = useCallback(() => {
    engine.allNotesOff(trackId);
    setUi({ chordsTrackId: null });
  }, [trackId, setUi]);
  const kb = useComputerKeyboard(trackId, close, 0.85, 'chords');

  useEffect(() => {
    if (!track || track.kind !== 'instrument' || !track.chords) setUi({ chordsTrackId: null });
  }, [track, setUi]);
  useEffect(() => {
    root.current?.focus();
  }, [trackId]);

  if (!track || !track.chords) return null;
  const cfg = track.chords;
  const vibe = vibeById(cfg.vibe);
  const on = chordToolActive(track);

  const set = (part: Partial<ChordToolConfig>, key: string) => {
    const cur = getProject().tracks.find((t) => t.id === trackId)?.chords ?? cfg;
    updateTrack(trackId, { chords: { ...cur, ...part } }, 'Edit Slipper-izer', { coalesce: `chords-${trackId}-${key}` });
  };

  // a pad plays its key in the keyboard's octave ([ ] or − / +), like the computer keys: the octave moves the chord
  const padOn = (pc: number) => {
    padNote.current = engine.previewNoteOn(trackId, (kb.octave + 1) * 12 + pc, 0.85);
    setPadDown(pc);
  };
  const padOff = () => {
    if (padNote.current !== null) engine.previewNoteOff(trackId, padNote.current);
    padNote.current = null;
    setPadDown(null);
  };
  const activePcs = new Set([...kb.active].map((n) => n % 12));
  if (padDown !== null) activePcs.add(padDown);

  const bake = () => {
    if (!clipCount) {
      uiToast('info', 'There are no MIDI clips on this track to bake yet — record or draw some notes first.');
      return;
    }
    if (!confirm(`Write the chords into ${clipCount} clip${clipCount === 1 ? '' : 's'} on "${track.name}" as real notes? The Slipper-izer is switched off afterwards (Undo brings everything back).`)) return;
    useProjectStore.getState().commit('Bake chords to notes', (p) => bakeChords(p, trackId));
    uiToast('info', `Baked chords into ${clipCount} clip${clipCount === 1 ? '' : 's'}. You can now edit every note in the piano roll.`);
  };

  const seg = <T extends string | number>(value: T, options: { v: T; label: string; title?: string }[], onPick: (v: T) => void, disabled = false) => (
    <div className={`inline-flex overflow-hidden rounded border border-line ${disabled ? 'opacity-40' : ''}`}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          disabled={disabled}
          title={o.title}
          onClick={() => onPick(o.v)}
          className={`h-6 px-2 text-[11px] ${value === o.v ? 'font-semibold text-black' : 'bg-panel-3 text-muted hover:text-fg'}`}
          style={value === o.v ? { background: GOLD } : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <>
    <div
      ref={root}
      tabIndex={-1}
      data-testid="slipperizer"
      onPointerDownCapture={win.raise}
      style={{ left: pos.x, top: pos.y, width: WIN_W, zIndex: win.z }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line-2 bg-panel shadow-2xl shadow-black/70 outline-none"
    >
      {/* header */}
      <div
        className="touch-control flex h-10 shrink-0 cursor-move items-center gap-2 border-b border-line bg-gradient-to-r from-[#2a2414] to-panel px-3"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input')) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          dragWin.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          const d = dragWin.current;
          if (d) setPos({ x: Math.min(window.innerWidth - 120, Math.max(-800, e.clientX - d.dx)), y: Math.min(window.innerHeight - 40, Math.max(0, e.clientY - d.dy)) });
        }}
        onPointerUp={() => (dragWin.current = null)}
      >
        <Footprints size={16} style={{ color: GOLD }} />
        <span className="text-[14px] font-bold tracking-[0.16em]" style={{ color: GOLD }}>
          GUCCI SLIPPER-IZER
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted">· chords for {track.name}</span>
        <button
          type="button"
          title={on ? 'Switch the chord tool off (keys play single notes again)' : 'Switch the chord tool on'}
          onClick={() => set({ enabled: !cfg.enabled }, 'enabled')}
          className={`ml-3 flex h-6 items-center gap-1 rounded px-2 text-[11px] font-semibold ${on ? 'text-black' : 'bg-panel-3 text-muted'}`}
          style={on ? { background: GOLD } : undefined}
        >
          <Power size={12} /> {on ? 'On' : 'Off'}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" title="Write the chords into this track's clips as real notes (then edit them freely)" onClick={bake} disabled={!on} className="flex h-6 items-center gap-1 rounded bg-panel-3 px-2 text-[11px] hover:bg-line-2 disabled:opacity-40">
            <Wand2 size={12} /> Bake to notes
          </button>
          <button type="button" title="Close (Esc)" onClick={close} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-panel-3 hover:text-fg">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className={`flex flex-col gap-2 p-3 ${on ? '' : 'opacity-50'}`}>
        {/* vibes */}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">1 · Pick a vibe</div>
          <div className="flex flex-wrap gap-1">
            {VIBES.map((v) => (
              <button
                key={v.id}
                type="button"
                title={v.feel}
                onClick={() => set({ vibe: v.id, key: v.defaultKey, progression: 0, pattern: v.pattern }, 'vibe')}
                className={`h-7 rounded px-2.5 text-[11px] ${cfg.vibe === v.id ? 'font-semibold text-black' : 'bg-panel-3 text-fg hover:bg-line-2'}`}
                style={cfg.vibe === v.id ? { background: GOLD } : undefined}
              >
                {v.name}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-dim">{vibe.feel}</div>
        </div>

        {/* progression / key / mode */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">2 · Progression</div>
            {seg(cfg.progression, vibe.progressions.map((p, i) => ({ v: i, label: p.name })), (v) => set({ progression: v }, 'prog'))}
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Key</div>
            <select value={cfg.key} onChange={(e) => set({ key: Number(e.target.value) }, 'key')} className="h-6 w-28" title="Moves every chord up or down — pick whatever fits your song or voice">
              {Array.from({ length: 12 }, (_, k) => (
                <option key={k} value={k}>
                  {keyName({ vibe: cfg.vibe, key: k })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">3 · How keys play</div>
            {seg(
              cfg.play,
              [
                { v: 'chord', label: '1 key = 1 chord', title: 'Each key plays its chord for as long as you hold it' },
                { v: 'auto', label: 'Auto-play', title: 'Hold one key and the whole progression plays in rhythm, starting from that chord' },
              ],
              (v) => set({ play: v }, 'play'),
            )}
          </div>
          <div className="flex items-end gap-2">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Sound</div>
              <div className="flex gap-1">
                {seg(cfg.voicing, [{ v: 'close', label: 'Close', title: 'Compact chords' }, { v: 'wide', label: 'Wide', title: 'Open, spacious chords' }], (v) => set({ voicing: v }, 'voicing'))}
                <button
                  type="button"
                  title="Add the chord's root note low as a bass"
                  onClick={() => set({ bass: !cfg.bass }, 'bass')}
                  className={`h-6 rounded px-2 text-[11px] ${cfg.bass ? 'font-semibold text-black' : 'bg-panel-3 text-muted'}`}
                  style={cfg.bass ? { background: GOLD } : undefined}
                >
                  Bass
                </button>
              </div>
            </div>
            <Knob spec={STRUM_SPEC} value={cfg.strum} size={28} color={GOLD} onChange={(v) => set({ strum: v }, 'strum')} title={`Strum: roll the chord notes like a hand (${STRUM_SPEC.format(cfg.strum)})`} />
          </div>
        </div>

        {cfg.play === 'auto' && (
          <div className="flex flex-wrap items-end gap-4 rounded-md border border-line bg-panel-2 px-2 py-1.5">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Rhythm</div>
              {seg(cfg.pattern, PATTERNS.map((p) => ({ v: p.id, label: p.label, title: p.hint })), (v) => set({ pattern: v }, 'pattern'))}
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Speed</div>
              {seg(cfg.rate, [{ v: 4, label: '1/4' }, { v: 8, label: '1/8' }, { v: 16, label: '1/16' }] as { v: 4 | 8 | 16; label: string }[], (v) => set({ rate: v }, 'rate'), cfg.pattern !== 'stabs' && cfg.pattern !== 'arp')}
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Chord change every</div>
              {seg(cfg.chordBars, [{ v: 0.5, label: '½ bar' }, { v: 1, label: '1 bar' }, { v: 2, label: '2 bars' }] as { v: 0.5 | 1 | 2; label: string }[], (v) => set({ chordBars: v }, 'bars'))}
            </div>
            <div className="max-w-[240px] text-[10px] leading-snug text-dim">Hold a key: C plays the loop from chord 1, D from chord 2 … Follows the song tempo.</div>
          </div>
        )}

        {/* chord pads laid out like the keys that trigger them */}
        <div>
          <div className="mb-1 flex items-baseline gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            4 · Play — click a pad or press its key
            <span className="normal-case tracking-normal text-dim">C D E F = the progression · G A B = extras · black keys = spicy versions · the octave selector below moves the chords</span>
          </div>
          <div className="relative h-[124px] select-none" data-testid="chord-pads">
            <div className="absolute inset-x-0 bottom-0 grid h-[78px] grid-cols-7 gap-1.5">
              {WHITE_KEYS.map((pc, slot) => {
                const ch = chordAtSlot(cfg, slot);
                const lit = activePcs.has(pc);
                const loop = slot < 4;
                return (
                  <button
                    key={pc}
                    type="button"
                    disabled={!on}
                    onPointerDown={(e) => {
                      (e.currentTarget as Element).setPointerCapture(e.pointerId);
                      padOn(pc);
                    }}
                    onPointerUp={padOff}
                    onPointerCancel={padOff}
                    title={`Key ${LETTERS[slot]}: ${ch.name}${loop ? ` — chord ${slot + 1} of the progression` : ' — extra chord'}`}
                    className="flex flex-col items-center justify-end rounded-md border pb-1.5 transition-colors"
                    style={{
                      background: lit ? GOLD : loop ? '#26221a' : '#1c1c26',
                      borderColor: loop ? '#5a4a22' : '#33334a',
                      color: lit ? '#111' : '#f3ecd8',
                    }}
                  >
                    <span className="text-[15px] font-bold">{ch.name}</span>
                    <span className="text-[10px] opacity-70">
                      {LETTERS[slot]} key{loop ? ` · ${slot + 1}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
            {BLACK_KEYS.map(({ pc, slot, after }) => {
              const ch = chordAtSlot(cfg, slot, true);
              const lit = activePcs.has(pc);
              return (
                <button
                  key={pc}
                  type="button"
                  disabled={!on}
                  onPointerDown={(e) => {
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    padOn(pc);
                  }}
                  onPointerUp={padOff}
                  onPointerCancel={padOff}
                  title={`Key ${noteName(pc, { vibe: 'jazzy', key: 0 })} (black): ${ch.name} — a spicier ${chordAtSlot(cfg, slot).name}`}
                  className="absolute top-0 flex h-[42px] flex-col items-center justify-center rounded-md border text-[11px]"
                  style={{
                    left: `calc(${((after + 1) / 7) * 100}% - 50px)`,
                    width: 92,
                    background: lit ? GOLD : '#111118',
                    borderColor: '#3a3a52',
                    color: lit ? '#111' : '#d8d0ff',
                  }}
                >
                  <span className="font-semibold">{ch.name}</span>
                  <span className="text-[9px] opacity-60">spicy</span>
                </button>
              );
            })}
          </div>
        </div>
        {!on && <div className="text-[11px] text-warn">The Slipper-izer is off — keys play single notes. Switch it on to play chords.</div>}
        {on && track.armed && <div className="text-[11px] text-dim">Armed: recording stores the single keys you play; the clip plays them back as chords.</div>}
      </div>

      <KeyboardStrip trackId={trackId} kb={kb} low={48} high={84} />
    </div>
    {/* the charm: a pair of slippers dangling from the window's bottom edge */}
    <DanglingSlippers x={pos.x + 64} y={pos.y + winH} z={win.z} />
    </>
  );
}
