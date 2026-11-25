/**
 * Real level metering. A ChannelSplitter feeds one AnalyserNode per channel;
 * the UI reads the latest time-domain block on each animation frame and
 * computes the true sample peak. Nothing here is simulated.
 */
const FFT = 2048;

export interface MeterReading {
  peakL: number;
  peakR: number;
}

export class StereoMeter {
  readonly input: AudioNode;
  private readonly splitter: ChannelSplitterNode | null = null;
  private readonly aL: AnalyserNode | null = null;
  private readonly aR: AnalyserNode | null = null;
  private readonly buf = new Float32Array(FFT);

  constructor(ctx: BaseAudioContext, realtime: boolean) {
    if (!realtime) {
      // Offline contexts don't need meters; use a dead-end gain so connections are valid.
      this.input = new GainNode(ctx, { gain: 0 });
      return;
    }
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const aL = new AnalyserNode(ctx, { fftSize: FFT, smoothingTimeConstant: 0 });
    const aR = new AnalyserNode(ctx, { fftSize: FFT, smoothingTimeConstant: 0 });
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);
    this.splitter = splitter;
    this.aL = aL;
    this.aR = aR;
    this.input = splitter;
  }

  read(out: MeterReading): MeterReading {
    out.peakL = this.peak(this.aL);
    out.peakR = this.peak(this.aR);
    return out;
  }

  private peak(a: AnalyserNode | null): number {
    if (!a) return 0;
    a.getFloatTimeDomainData(this.buf);
    let p = 0;
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const v = Math.abs(b[i] as number);
      if (v > p) p = v;
    }
    return p;
  }

  dispose(): void {
    this.splitter?.disconnect();
    this.input.disconnect();
  }
}
