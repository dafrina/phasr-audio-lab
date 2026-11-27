import { useEffect, useRef, useState } from 'react';
import { engine } from '../../audio/engine';
import type { MeterReading } from '../../audio/meter';
import { recorder } from '../../audio/recorder';

interface MeterProps {
  /** track id, 'master', or 'input' (the open recording input) */
  source: string;
  orientation?: 'vertical' | 'horizontal';
  width: number;
  height: number;
  showPeak?: boolean;
}

const FLOOR_DB = -60;

function dbNorm(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Stereo peak meter reading real levels from the engine's analysers each
 * frame, with ~1.5 s peak hold and a latching clip indicator.
 */
export function Meter({ source, orientation = 'vertical', width, height, showPeak = true }: MeterProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [clipped, setClipped] = useState(false);
  const clipRef = useRef(false);

  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reading: MeterReading = { peakL: 0, peakR: 0 };
    const disp = [0, 0];
    const hold = [0, 0];
    const holdT = [0, 0];
    let raf = 0;
    /** what's on the canvas (bar and hold positions in px): a frame that would look the same isn't redrawn */
    let drawn = '';
    const vertical = orientation === 'vertical';
    const len = vertical ? height : width;
    const grad = vertical ? g.createLinearGradient(0, height, 0, 0) : g.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, '#4ade80');
    grad.addColorStop(0.72, '#a3e635');
    grad.addColorStop(0.88, '#facc15');
    grad.addColorStop(1, '#f43f5e');
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (source === 'master') engine.readMasterMeter(reading);
      else if (source === 'input') recorder.readInputMeter(reading);
      else engine.readTrackMeter(source, reading);
      const peaks = [reading.peakL, reading.peakR];
      for (let ch = 0; ch < 2; ch++) {
        const p = peaks[ch] as number;
        if (p >= 1 && !clipRef.current) {
          clipRef.current = true;
          setClipped(true);
        }
        const target = dbNorm(p);
        // instant attack, smooth fall-off (~20 dB/s visual decay)
        disp[ch] = target > (disp[ch] as number) ? target : Math.max(target, (disp[ch] as number) - 0.006);
        if (target >= (hold[ch] as number) || now - (holdT[ch] as number) > 1500) {
          hold[ch] = target;
          holdT[ch] = now;
        }
      }
      const key = `${Math.round((disp[0] as number) * len * 2)},${Math.round((disp[1] as number) * len * 2)},${Math.round((hold[0] as number) * len)},${Math.round((hold[1] as number) * len)}`;
      if (key === drawn) return;
      drawn = key;
      g.clearRect(0, 0, width, height);
      g.fillStyle = '#0a0a10';
      g.fillRect(0, 0, width, height);
      for (let ch = 0; ch < 2; ch++) {
        const d = disp[ch] as number;
        const h = hold[ch] as number;
        g.fillStyle = grad;
        if (vertical) {
          const bw = (width - 1) / 2;
          const x = ch * (bw + 1);
          g.fillRect(x, height * (1 - d), bw, height * d);
          if (h > 0.01) {
            g.fillStyle = h > 0.97 ? '#f43f5e' : '#e8e8f2';
            g.fillRect(x, height * (1 - h), bw, 1);
          }
        } else {
          const bh = (height - 1) / 2;
          const y = ch * (bh + 1);
          g.fillRect(0, y, width * d, bh);
          if (h > 0.01) {
            g.fillStyle = h > 0.97 ? '#f43f5e' : '#e8e8f2';
            g.fillRect(width * h - 1, y, 1, bh);
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source, width, height, orientation]);

  return (
    <div className={`flex ${orientation === 'vertical' ? 'flex-col' : 'flex-row'} items-center gap-0.5`}>
      {showPeak && (
        <button
          type="button"
          title={clipped ? 'Clipped (≥ 0 dBFS). Click to reset.' : 'Peak indicator'}
          onClick={() => {
            clipRef.current = false;
            setClipped(false);
          }}
          className={`h-1.5 w-2.5 shrink-0 rounded-[1px] ${clipped ? 'bg-bad' : 'bg-panel-3'}`}
        />
      )}
      <canvas ref={canvas} style={{ width, height }} className="rounded-[2px]" />
    </div>
  );
}
