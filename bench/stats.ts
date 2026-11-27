/** Benchmark helpers: repeat a measurement, report median and range, and say where it ran. */
import { cpus } from 'node:os';

export const RUNS = Number(process.env.BENCH_RUNS ?? 5);

/** run `measure` RUNS times (each returns a number, e.g. × realtime); median and spread */
export function repeat(measure: () => number): { median: number; min: number; max: number } {
  const xs = Array.from({ length: RUNS }, measure).sort((a, b) => a - b);
  return { median: xs[Math.floor(xs.length / 2)] as number, min: xs[0] as number, max: xs[xs.length - 1] as number };
}

export const fmtX = (s: { median: number; min: number; max: number }, digits = 1) =>
  `${s.median.toFixed(digits)}× realtime (range ${s.min.toFixed(digits)}–${s.max.toFixed(digits)}, ${(1000 / s.median).toFixed(1)} ms per audio second)`;

export function environment(): string {
  const c = cpus();
  return `Node ${process.version}, V8 ${process.versions.v8}, ${c[0]?.model ?? 'unknown CPU'} (${c.length} threads), 48 kHz, 128-frame blocks, median of ${RUNS} runs`;
}
