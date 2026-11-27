/**
 * Stretched copies of audio assets for warped clips, shared by playback and
 * export (so both play the same samples). Rendered one at a time in a Web
 * Worker (inline where there is none, e.g. tests), cached per asset and
 * stretch factor.
 *
 *  - want(): the set the project needs now. Queued jobs nobody wants any more
 *    are dropped, and a job only starts once its factor has been wanted for a
 *    moment (dragging the tempo doesn't render every tempo on the way).
 *  - Memory: cached copies the project doesn't use are evicted, oldest first,
 *    above MAX_SAMPLES (≈ 256 MB of float audio).
 *  - Until a copy is ready, playback uses the nearest cached one (or the
 *    original) at a corrected playback rate — right timing, briefly a shade
 *    off in pitch — and reschedules when it arrives (onReady).
 */
import StretchWorker from './stretch.worker.ts?worker';
import { timeStretch } from './vocoder';

const MAX_SAMPLES = 64 * 1024 * 1024;
const START_DELAY_MS = 150;

interface Entry {
  buffer: AudioBuffer;
  used: number;
}

interface Job {
  key: string;
  assetId: string;
  factor: number;
  source: AudioBuffer;
  waiters: ((b: AudioBuffer | null) => void)[];
  wantedSince: number;
}

const keyOf = (assetId: string, factor: number) => `${assetId}|${factor.toFixed(4)}`;

export class StretchCache {
  private readonly done = new Map<string, Entry>();
  private readonly queue = new Map<string, Job>();
  private running: Job | null = null;
  private wanted = new Set<string>();
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tick = 0;
  /** called with the key when a stretched copy becomes available */
  readonly listeners = new Set<(key: string) => void>();
  /** how many jobs ran (tests / measurements) and how long they took, ms */
  readonly stats = { jobs: 0, ms: 0 };

  get(assetId: string, factor: number): AudioBuffer | null {
    const e = this.done.get(keyOf(assetId, factor));
    if (!e) return null;
    e.used = ++this.tick;
    return e.buffer;
  }

  /** the cached copy of an asset whose factor is closest to `factor` */
  nearest(assetId: string, factor: number): { buffer: AudioBuffer; factor: number } | null {
    let best: { buffer: AudioBuffer; factor: number } | null = null;
    for (const [key, e] of this.done) {
      const [id, f] = key.split('|');
      if (id !== assetId) continue;
      const fv = Number(f);
      if (!best || Math.abs(Math.log(fv / factor)) < Math.abs(Math.log(best.factor / factor))) best = { buffer: e.buffer, factor: fv };
    }
    return best;
  }

  /** the copies the project needs now (keys of assetId + factor) */
  want(needs: Iterable<{ assetId: string; factor: number; source: AudioBuffer }>): void {
    const now = performance.now();
    const next = new Set<string>();
    for (const n of needs) {
      const key = keyOf(n.assetId, n.factor);
      next.add(key);
      if (this.done.has(key) || this.running?.key === key) continue;
      const q = this.queue.get(key);
      if (q) continue;
      this.queue.set(key, { key, assetId: n.assetId, factor: n.factor, source: n.source, waiters: [], wantedSince: now });
    }
    this.wanted = next;
    // jobs nobody waits for and the project no longer needs are dropped
    for (const [key, j] of this.queue) if (!next.has(key) && !j.waiters.length) this.queue.delete(key);
    this.evict();
    this.schedule();
  }

  /** a stretched copy, now or when rendered (export waits for these; it doesn't wait for the start delay) */
  ensure(assetId: string, source: AudioBuffer, factor: number): Promise<AudioBuffer | null> {
    const ready = this.get(assetId, factor);
    if (ready) return Promise.resolve(ready);
    const key = keyOf(assetId, factor);
    return new Promise((resolve) => {
      if (this.running?.key === key) {
        this.running.waiters.push(resolve);
        return;
      }
      let j = this.queue.get(key);
      if (!j) this.queue.set(key, (j = { key, assetId, factor, source, waiters: [], wantedSince: 0 }));
      j.waiters.push(resolve);
      j.wantedSince = 0; // someone is waiting: no start delay
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.running || this.timer || !this.queue.size) return;
    // the job that has been wanted longest (or is awaited) first, once it has been wanted long enough
    const now = performance.now();
    let pick: Job | null = null;
    for (const j of this.queue.values()) if (!pick || j.wantedSince < pick.wantedSince) pick = j;
    if (!pick) return;
    const wait = Math.max(0, pick.wantedSince + START_DELAY_MS - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      const job = this.queue.get(pick.key);
      if (!job) return this.schedule();
      if (!job.waiters.length && !this.wanted.has(job.key)) {
        this.queue.delete(job.key);
        return this.schedule();
      }
      this.queue.delete(job.key);
      this.run(job);
    }, wait);
  }

  private run(job: Job): void {
    this.running = job;
    const t0 = performance.now();
    const channels = Array.from({ length: Math.min(2, job.source.numberOfChannels) }, (_, c) => job.source.getChannelData(c).slice());
    const finish = (out: Float32Array[] | null) => {
      this.running = null;
      this.stats.jobs++;
      this.stats.ms += performance.now() - t0;
      let buffer: AudioBuffer | null = null;
      if (out && out[0]) {
        buffer = new AudioBuffer({ length: out[0].length, numberOfChannels: out.length, sampleRate: job.source.sampleRate });
        out.forEach((c, i) => buffer!.copyToChannel(c as Float32Array<ArrayBuffer>, i));
        this.done.set(job.key, { buffer, used: ++this.tick });
        this.evict();
      }
      for (const w of job.waiters) w(buffer);
      if (buffer) for (const l of this.listeners) l(job.key);
      this.schedule();
    };
    const worker = this.getWorker();
    if (!worker) {
      // no worker here: compute inline (after this tick, so callers see the promise first)
      setTimeout(() => finish(timeStretch(channels, job.source.sampleRate, job.factor)), 0);
      return;
    }
    const id = this.nextId++;
    const onMessage = (e: MessageEvent<{ id: number; channels?: Float32Array[]; error?: string }>) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      finish(e.data.channels ?? null);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, channels, sampleRate: job.source.sampleRate, factor: job.factor }, channels.map((c) => c.buffer));
  }

  private getWorker(): Worker | null {
    if (this.worker || this.workerFailed) return this.worker;
    try {
      this.worker = new StretchWorker();
    } catch {
      this.workerFailed = true;
    }
    return this.worker;
  }

  private evict(): void {
    let total = 0;
    for (const e of this.done.values()) total += e.buffer.length * e.buffer.numberOfChannels;
    if (total <= MAX_SAMPLES) return;
    const old = [...this.done.entries()].filter(([k]) => !this.wanted.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k, e] of old) {
      if (total <= MAX_SAMPLES) break;
      this.done.delete(k);
      total -= e.buffer.length * e.buffer.numberOfChannels;
    }
  }
}

/** The one cache playback and export share. */
export const stretchCache = new StretchCache();
