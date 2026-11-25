/**
 * Recording capture processor.
 *
 * Copies input samples between an exact start frame and stop frame (both in
 * AudioContext frames, so the recording is sample-aligned to the transport)
 * into fixed-size chunks that are transferred to the main thread. The main
 * thread sends chunk buffers back for reuse, so steady-state recording does
 * no allocation inside process().
 *
 * Messages in:  { type: 'start', frame } | { type: 'stop', frame } | { type: 'recycle', l, r } | { type: 'dispose' }
 * Messages out: { type: 'chunk', l, r, frames } | { type: 'done', frames }
 */
interface WorkletProcessorBase {
  readonly port: MessagePort;
}
interface WorkletScope {
  AudioWorkletProcessor: new (options?: unknown) => WorkletProcessorBase;
  registerProcessor: (name: string, ctor: unknown) => void;
  currentFrame: number;
}
const scope = globalThis as unknown as WorkletScope;

const CHUNK = 8192;
const POOL = 6;

type InMsg =
  | { type: 'start'; frame: number }
  | { type: 'stop'; frame: number }
  | { type: 'recycle'; l: Float32Array; r: Float32Array }
  | { type: 'dispose' };

class RecorderProcessor extends scope.AudioWorkletProcessor {
  private pool: [Float32Array, Float32Array][] = [];
  private curL: Float32Array | null = null;
  private curR: Float32Array | null = null;
  private fill = 0;
  private startFrame = -1;
  private stopFrame = Number.POSITIVE_INFINITY;
  private recording = false;
  private total = 0;
  private alive = true;

  constructor(options?: unknown) {
    super(options);
    for (let i = 0; i < POOL; i++) this.pool.push([new Float32Array(CHUNK), new Float32Array(CHUNK)]);
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      const m = e.data;
      if (m.type === 'start') {
        this.startFrame = m.frame;
        this.stopFrame = Number.POSITIVE_INFINITY;
        this.recording = true;
        this.total = 0;
        this.fill = 0;
      } else if (m.type === 'stop') {
        this.stopFrame = m.frame;
      } else if (m.type === 'recycle') {
        if (m.l.length === CHUNK && m.r.length === CHUNK) this.pool.push([m.l, m.r]);
      } else if (m.type === 'dispose') {
        this.alive = false;
      }
    };
  }

  private take(): void {
    const next = this.pool.pop();
    // Pool exhausted (main thread busy): allocate rather than drop audio.
    const [l, r] = next ?? [new Float32Array(CHUNK), new Float32Array(CHUNK)];
    this.curL = l;
    this.curR = r;
    this.fill = 0;
  }

  private flush(): void {
    if (!this.curL || !this.curR || this.fill === 0) return;
    const l = this.curL;
    const r = this.curR;
    this.port.postMessage({ type: 'chunk', l, r, frames: this.fill }, [l.buffer, r.buffer]);
    this.curL = null;
    this.curR = null;
    this.fill = 0;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // keep the output silent; it only exists so the node is pulled by the graph
    const out = outputs[0];
    if (out) for (const ch of out) ch.fill(0);
    if (!this.recording) return this.alive;
    const input = inputs[0];
    const inL = input?.[0];
    const inR = input?.[1] ?? inL;
    const block = out?.[0]?.length ?? 128;
    const f0 = scope.currentFrame;
    for (let i = 0; i < block; i++) {
      const f = f0 + i;
      if (f < this.startFrame) continue;
      if (f >= this.stopFrame) {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'done', frames: this.total });
        return this.alive;
      }
      if (!this.curL) this.take();
      const l = this.curL as Float32Array;
      const r = this.curR as Float32Array;
      // disconnected / silent input still produces (zero) samples so timing stays continuous
      l[this.fill] = inL ? (inL[i] as number) : 0;
      r[this.fill] = inR ? (inR[i] as number) : 0;
      this.fill++;
      this.total++;
      if (this.fill === CHUNK) this.flush();
    }
    return this.alive;
  }
}

scope.registerProcessor('phasr-recorder', RecorderProcessor);
