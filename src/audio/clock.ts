/**
 * Scheduler wake-up clock. Runs setInterval inside a dedicated Worker, because
 * main-thread timers are throttled heavily in background tabs. The clock only
 * decides *when to look ahead*; actual event times always come from
 * AudioContext.currentTime, so jitter here never affects timing accuracy.
 */
const WORKER_SRC = `
let id = null;
onmessage = (e) => {
  const d = e.data;
  if (d.cmd === 'start') {
    if (id !== null) clearInterval(id);
    id = setInterval(() => postMessage(0), d.interval);
  } else if (d.cmd === 'stop') {
    if (id !== null) clearInterval(id);
    id = null;
  }
};`;

export class SchedulerClock {
  private worker: Worker | null = null;
  private fallback: ReturnType<typeof setInterval> | null = null;
  private readonly onTick: () => void;

  constructor(onTick: () => void) {
    this.onTick = onTick;
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = () => this.onTick();
      URL.revokeObjectURL(url);
    } catch {
      this.worker = null;
    }
  }

  start(intervalMs: number): void {
    this.stop();
    if (this.worker) this.worker.postMessage({ cmd: 'start', interval: intervalMs });
    else this.fallback = setInterval(this.onTick, intervalMs);
  }

  stop(): void {
    this.worker?.postMessage({ cmd: 'stop' });
    if (this.fallback !== null) clearInterval(this.fallback);
    this.fallback = null;
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }
}
