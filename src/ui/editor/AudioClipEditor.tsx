import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AudioLines, Gauge, Repeat, Sparkles } from 'lucide-react';
import { engine } from '../../audio/engine';
import { audioSourcePosition } from '../../audio/scheduling';
import { WARP_GOOD_MAX, WARP_GOOD_MIN, WARP_MAX, WARP_MIN, warpRate } from '../../audio/warp';
import { peakRange, pickLevel } from '../../audio/peaks';
import { dbToGain, gainToDb } from '../../core/ids';
import { PPQ, ticksToSeconds } from '../../core/time';
import { setClipLoop } from '../../project/clipOps';
import type { AudioClip } from '../../project/types';
import { getProject, upsertClips, useProjectStore } from '../../state/projectStore';
import type { NumericParamSpec } from '../../synth/params';
import { Knob } from '../common/Knob';

const GAIN_SPEC: NumericParamSpec = { label: 'Gain', min: -24, max: 12, default: 0, curve: 'linear', bipolar: true, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` };
const FADE_SPEC: NumericParamSpec = { label: 'Fade', min: 0.002, max: 4, default: 0.005, curve: 'exp', format: (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`) };

/**
 * Detailed view of an audio clip: the whole source asset with the region the
 * clip plays highlighted, fades drawn over it, and the playback position.
 * Everything here edits clip metadata only — the source audio is never changed.
 */
export function AudioClipEditor({ clipId }: { clipId: string }) {
  const clip = useProjectStore((s) => s.project.clips[clipId]) as AudioClip | undefined;
  const bpm = useProjectStore((s) => s.project.bpm);
  const asset = clip ? engine.assets.get(clip.assetId) : undefined;
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(800);
  const [h, setH] = useState(200);
  const taps = useRef<number[]>([]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth);
      setH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = getProject().clips[clipId];
      const canvas = cv.current;
      if (!c || c.kind !== 'audio' || !canvas || !asset) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dur = asset.ref.durationSec;
      const secToX = (s: number) => (s / dur) * w;
      g.fillStyle = '#0b0b11';
      g.fillRect(0, 0, w, h);
      // (source seconds: a warped clip runs through its source at its rate)
      const rate = warpRate(c, getProject().bpm);
      const clipSec = ticksToSeconds(c.length, getProject().bpm) * rate;
      const regionStart = c.sourceOffset;
      const regionEnd = c.loop && c.loopSeconds > 0 ? c.sourceOffset + c.loopSeconds : Math.min(dur, c.sourceOffset + clipSec);
      // used region
      g.fillStyle = 'rgba(118,93,252,0.12)';
      g.fillRect(secToX(regionStart), 0, secToX(regionEnd) - secToX(regionStart), h);
      // waveform
      const level = pickLevel(asset.peaks, (asset.peaks.frames / w) * 1);
      const out: [number, number] = [0, 0];
      const mid = h / 2;
      const amp = (h / 2 - 6) * Math.min(2, c.gain);
      for (let x = 0; x < w; x++) {
        const f0 = (x / w) * asset.peaks.frames;
        const f1 = ((x + 1) / w) * asset.peaks.frames;
        peakRange(level, f0, f1, out);
        const s = (x / w) * dur;
        g.fillStyle = s >= regionStart && s < regionEnd ? '#b9adff' : '#3a3a52';
        g.fillRect(x, mid - out[1] * amp, 1, Math.max(1, (out[1] - out[0]) * amp));
      }
      g.fillStyle = '#26263a';
      g.fillRect(0, mid, w, 1);
      // fades (only meaningful for non-looping clips)
      if (!c.loop) {
        g.strokeStyle = '#facc15';
        g.beginPath();
        g.moveTo(secToX(regionStart), h);
        g.lineTo(secToX(regionStart + c.fadeIn * rate), 4);
        g.lineTo(secToX(regionEnd - c.fadeOut * rate), 4);
        g.lineTo(secToX(regionEnd), h);
        g.stroke();
      }
      // region edges
      g.fillStyle = '#765dfc';
      g.fillRect(secToX(regionStart), 0, 2, h);
      g.fillRect(secToX(regionEnd) - 2, 0, 2, h);
      // playback position inside the source
      const rel = (engine.transport?.getTick() ?? 0) - c.start;
      if (rel >= 0 && rel < c.length) {
        const pos = audioSourcePosition(c, ticksToSeconds(rel, getProject().bpm), getProject().bpm);
        const px = Math.round(secToX(pos)) + 0.5;
        g.strokeStyle = '#f5f5ff';
        g.beginPath();
        g.moveTo(px, 0);
        g.lineTo(px, h);
        g.stroke();
      }
      // time labels
      g.fillStyle = '#6a6a84';
      g.font = '10px ui-monospace, Menlo, monospace';
      g.textBaseline = 'top';
      const step = dur > 60 ? 10 : dur > 20 ? 5 : dur > 5 ? 1 : 0.5;
      for (let s = 0; s <= dur; s += step) {
        g.fillRect(secToX(s), h - 6, 1, 6);
        g.fillText(`${s.toFixed(step < 1 ? 1 : 0)}s`, secToX(s) + 2, 3);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [clipId, asset, w, h]);

  if (!clip || clip.kind !== 'audio') return <div className="p-4 text-muted">Clip not found.</div>;
  if (!asset) return <div className="p-4 text-bad">The audio file for this clip is missing.</div>;

  const update = (part: Partial<AudioClip>, label: string, key?: string) => {
    const c = getProject().clips[clipId];
    if (c && c.kind === 'audio') upsertClips([{ ...c, ...part }], label, key ? { coalesce: `${key}-${clipId}` } : {});
  };
  const normalize = () => {
    const c = getProject().clips[clipId];
    if (!c || c.kind !== 'audio') return;
    const lvl = asset.peaks.levels[0];
    if (!lvl) return;
    const sr = asset.ref.sampleRate;
    const end = c.loop ? c.sourceOffset + c.loopSeconds : c.sourceOffset + ticksToSeconds(c.length, bpm) * warpRate(c, bpm);
    const out: [number, number] = [0, 0];
    peakRange(lvl, c.sourceOffset * sr, end * sr, out);
    const pk = Math.max(Math.abs(out[0]), Math.abs(out[1]));
    if (pk > 1e-4) update({ gain: Math.min(dbToGain(12), 0.98 / pk) }, 'Normalize clip');
  };
  const rate = warpRate(clip, bpm);
  const loopBeats = clip.loop ? (clip.loopSeconds * bpm) / 60 / rate : 0;
  const clipSec = ticksToSeconds(clip.length, bpm) * rate;
  const rough = clip.warp && (rate < WARP_GOOD_MIN || rate > WARP_GOOD_MAX);
  const limited = clip.warp && (bpm / clip.bpm < WARP_MIN || bpm / clip.bpm > WARP_MAX);
  const setTempo = (v: number) => update({ bpm: Math.round(Math.min(999, Math.max(10, v)) * 100) / 100, warp: true }, 'Clip tempo', 'clipbpm');
  const tap = () => {
    const now = performance.now();
    const t = taps.current.filter((x) => now - x < 2500);
    t.push(now);
    taps.current = t.slice(-8);
    if (taps.current.length >= 3) {
      const iv = (taps.current[taps.current.length - 1]! - taps.current[0]!) / (taps.current.length - 1);
      setTempo(60000 / iv);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2 text-[11px]">
        <AudioLines size={13} className="text-muted" />
        <span className="font-medium text-fg">{clip.name}</span>
        <span className="font-mono text-dim">
          {asset.ref.channels === 1 ? 'mono' : 'stereo'} · {asset.ref.sampleRate} Hz · source {asset.ref.durationSec.toFixed(2)} s · plays from {clip.sourceOffset.toFixed(3)} s for {clipSec.toFixed(2)} s
        </span>
        <button type="button" title="Scale gain so the clip's peak reaches -0.2 dBFS (non-destructive)" onClick={normalize} className="ml-auto flex h-6 items-center gap-1 rounded bg-panel-3 px-2 hover:bg-line-2">
          <Sparkles size={12} /> Normalize
        </button>
        <button
          type="button"
          title="Loop the clip's source region when the clip is extended"
          onClick={() => {
            const c = getProject().clips[clipId];
            if (c) upsertClips([setClipLoop(c, !c.loop, bpm)], c.loop ? 'Unloop clip' : 'Loop clip');
          }}
          className={`flex h-6 items-center gap-1 rounded px-2 ${clip.loop ? 'bg-accent text-white' : 'bg-panel-3 hover:bg-line-2'}`}
        >
          <Repeat size={12} /> Loop
        </button>
        {clip.loop && (
          <label className="flex items-center gap-1 text-muted" title="Loop region length in beats">
            Loop
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={Number(loopBeats.toFixed(3))}
              onChange={(e) => {
                const beats = Math.max(0.0625, Number(e.target.value) || 1);
                const secs = Math.min(((beats * 60) / bpm) * rate, asset.ref.durationSec - clip.sourceOffset);
                update({ loopSeconds: secs, loopStartPhase: 0 }, 'Loop length');
              }}
              className="h-6 w-14 rounded border border-line bg-base px-1 text-center font-mono text-fg outline-none"
            />
            beats
          </label>
        )}
        <button
          type="button"
          title="Fit clip length to the remaining source audio"
          disabled={clip.loop}
          onClick={() => update({ length: Math.max(60, Math.floor((((asset.ref.durationSec - clip.sourceOffset) / rate) * bpm * PPQ) / 60)) }, 'Fit clip')}
          className="flex h-6 items-center rounded bg-panel-3 px-2 hover:bg-line-2 disabled:opacity-35"
        >
          Fit
        </button>
      </div>
      <div data-testid="clip-tempo" className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-[11px]">
        <button
          type="button"
          aria-pressed={clip.warp}
          title={clip.warp ? 'Warp on: the audio follows the project tempo (time-stretched, the pitch stays). Click to play it at its own speed.' : 'Warp off: the audio plays at its own speed whatever the tempo. Click to make it follow the project tempo.'}
          onClick={() => update({ warp: !clip.warp }, clip.warp ? 'Warp off' : 'Warp on')}
          className={`flex h-6 items-center gap-1 rounded px-2 ${clip.warp ? 'bg-accent text-white' : 'bg-panel-3 hover:bg-line-2'}`}
        >
          <Gauge size={12} /> Warp
        </button>
        <label className="flex items-center gap-1 text-muted" title="The tempo the audio was played at. With Warp on it plays at project tempo ÷ this.">
          Clip tempo
          <input
            data-testid="clip-bpm"
            type="number"
            min={10}
            max={999}
            step={0.01}
            value={clip.bpm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 10) setTempo(v);
            }}
            className="h-6 w-20 rounded border border-line bg-base px-1 text-center font-mono text-fg outline-none"
          />
          BPM
        </label>
        <button type="button" title="Tap along to the audio (3+ taps) to set its tempo" onClick={tap} className="h-6 rounded bg-panel-3 px-2 hover:bg-line-2">
          Tap
        </button>
        <button type="button" title="Half the tempo" onClick={() => setTempo(clip.bpm / 2)} className="h-6 rounded bg-panel-3 px-1.5 hover:bg-line-2">
          ÷2
        </button>
        <button type="button" title="Double the tempo" onClick={() => setTempo(clip.bpm * 2)} className="h-6 rounded bg-panel-3 px-1.5 hover:bg-line-2">
          ×2
        </button>
        <span data-testid="clip-rate" className={`font-mono ${rough ? 'text-warn' : 'text-dim'}`}>
          {clip.warp
            ? `plays at ${rate.toFixed(2)}× (${bpm} ÷ ${clip.bpm} BPM)${limited ? ` · limited to ${WARP_MIN}×–${WARP_MAX}×` : ''}${rough ? ' · far from 1×: the stretch is audibly rougher' : ''}`
            : 'at its own speed (no stretch)'}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0 items-center gap-3 border-r border-line bg-panel px-3">
          <Knob spec={GAIN_SPEC} value={Math.max(-24, gainToDb(clip.gain))} size={38} onChange={(v) => update({ gain: dbToGain(v) }, 'Clip gain', 'gain')} />
          <Knob spec={{ ...FADE_SPEC, label: 'Fade In' }} value={clip.fadeIn} disabled={clip.loop} onChange={(v) => update({ fadeIn: v }, 'Fade in', 'fin')} />
          <Knob spec={{ ...FADE_SPEC, label: 'Fade Out' }} value={clip.fadeOut} disabled={clip.loop} onChange={(v) => update({ fadeOut: v }, 'Fade out', 'fout')} />
        </div>
        <div ref={wrap} className="relative min-w-0 flex-1">
          <canvas ref={cv} style={{ width: w, height: h }} className="block" />
        </div>
      </div>
    </div>
  );
}
