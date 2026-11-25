import { useMemo } from 'react';
import { envelopeShape } from '../../synth/dsp/envelope';
import { Noise, WF_NOISE, WF_PULSE, WF_SAW, WF_SINE, WF_SQUARE, WF_TRIANGLE, previewSample } from '../../synth/dsp/oscillator';
import type { EnvelopeParams, OscWaveform } from '../../synth/params';

const WF_IDX: Record<OscWaveform, number> = { sine: WF_SINE, triangle: WF_TRIANGLE, saw: WF_SAW, square: WF_SQUARE, pulse: WF_PULSE, noise: WF_NOISE };

/** Two-cycle waveform preview reflecting waveform, pulse width and start phase. */
export function WaveformPreview({ waveform, pulseWidth, phase, enabled, width = 96, height = 40, color = '#9b8aff' }: {
  waveform: OscWaveform;
  pulseWidth: number;
  phase: number;
  enabled: boolean;
  width?: number;
  height?: number;
  color?: string;
}) {
  const d = useMemo(() => {
    const noise = new Noise(42);
    const n = 160;
    const pts: string[] = [];
    for (let i = 0; i <= n; i++) {
      const t = ((i / n) * 2 + phase) % 1;
      const v = previewSample(WF_IDX[waveform], t, pulseWidth, noise);
      const x = (i / n) * width;
      const y = height / 2 - v * (height / 2 - 4);
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, [waveform, pulseWidth, phase, width, height]);
  return (
    <svg width={width} height={height} className="rounded bg-base">
      <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="#22223a" />
      <path d={d} fill="none" stroke={enabled ? color : '#44445a'} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** Small icon per waveform for the selector buttons. */
export function WaveIcon({ waveform, size = 18 }: { waveform: OscWaveform; size?: number }) {
  const h = size * 0.6;
  const w = size;
  const m = h / 2;
  const paths: Record<OscWaveform, string> = {
    sine: `M0,${m} C${w * 0.15},${-m * 0.3} ${w * 0.35},${-m * 0.3} ${w / 2},${m} S${w * 0.85},${h + m * 0.3} ${w},${m}`,
    triangle: `M0,${m} L${w / 4},1 L${(3 * w) / 4},${h - 1} L${w},${m}`,
    saw: `M0,${h - 1} L${w / 2},1 L${w / 2},${h - 1} L${w},1`,
    square: `M0,${h - 1} L0,1 L${w / 2},1 L${w / 2},${h - 1} L${w},${h - 1} L${w},1`,
    pulse: `M0,${h - 1} L0,1 L${w / 4},1 L${w / 4},${h - 1} L${w},${h - 1}`,
    noise: `M0,${m} L2,2 L4,${h - 2} L6,3 L8,${h - 3} L10,1 L12,${h - 1} L14,4 L16,${h - 4} L${w},${m}`,
  };
  return (
    <svg width={w} height={h} viewBox={`-1 -1 ${w + 2} ${h + 2}`} className="overflow-visible">
      <path d={paths[waveform]} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

/** Live ADSR curve. Time axis is scaled so all stages stay visible. */
export function EnvelopeGraph({ env, width = 150, height = 52, color = '#9b8aff' }: { env: EnvelopeParams; width?: number; height?: number; color?: string }) {
  const d = useMemo(() => {
    // compress long times so short and long envelopes both read well
    const warp = (t: number) => Math.sqrt(t);
    const hold = 0.35;
    const pts = envelopeShape(env, hold * hold);
    const total = warp(env.attack) + warp(env.decay) + hold + warp(env.release);
    const toX = (t: number) => {
      // piecewise warp per stage
      const a = env.attack;
      const dd = env.decay;
      const relStart = a + dd + hold * hold;
      let x: number;
      if (t <= a) x = warp(t);
      else if (t <= a + dd) x = warp(a) + warp(t - a);
      else if (t <= relStart) x = warp(a) + warp(dd) + ((t - a - dd) / (hold * hold)) * hold;
      else x = warp(a) + warp(dd) + hold + warp(t - relStart);
      return (x / total) * (width - 4) + 2;
    };
    const toY = (v: number) => height - 3 - v * (height - 6);
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ');
  }, [env, width, height]);
  return (
    <svg width={width} height={height} className="rounded bg-base">
      <path d={`${d} L${width - 2},${height - 3} L2,${height - 3} Z`} fill={`${color}22`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
