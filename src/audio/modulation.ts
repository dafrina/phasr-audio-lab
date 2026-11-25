/**
 * Modulation router: one modulator node (phasr-modsource worklet) per enabled
 * route. Audio routes feed the source track's sidechain tap into the node;
 * MIDI routes receive trigger times from the transport (and live input). The
 * node's 0..1 output goes through one GainNode per target AudioParam whose
 * gain is the route depth in that param's units, so the param receives
 * `static/automated value + depth · envelope` at audio rate.
 *
 * Works on any BaseAudioContext, so offline export can build the same graph.
 */
import type { ModRoute, Project } from '../project/types';
import type { ModSettings } from './modsource/ModSourceCore';
import type { TrackChannel } from './trackChannel';

export const MODSOURCE_PROCESSOR = 'phasr-modsource';

interface RouteNodes {
  route: ModRoute;
  ownerTrackId: string;
  node: AudioWorkletNode;
  analyser: AnalyserNode | null;
  depthGains: GainNode[];
  tap: AudioNode | null;
  settingsKey: string;
}

function settingsOf(r: ModRoute): ModSettings {
  return { mode: r.source, attack: r.attack, release: r.release, threshold: r.threshold, hold: r.hold, invert: r.invert };
}

export class ModulationRouter {
  private readonly ctx: BaseAudioContext;
  private readonly channel: (id: string) => TrackChannel | undefined;
  private readonly realtime: boolean;
  private readonly nodes = new Map<string, RouteNodes>();
  /** source track id → route ids driven by its MIDI notes */
  private midiBySource = new Map<string, string[]>();
  private readonly buf = new Float32Array(32);

  constructor(ctx: BaseAudioContext, channel: (id: string) => TrackChannel | undefined, realtime: boolean) {
    this.ctx = ctx;
    this.channel = channel;
    this.realtime = realtime;
  }

  /**
   * Bring the modulation graph in line with the project. Called after the
   * track channels (and their effect units) have been synced.
   * `initialTriggers` (offline export) supplies all MIDI trigger times up front.
   */
  sync(project: Project, initialTriggers?: Map<string, { time: number; note: number }[]>): void {
    const seen = new Set<string>();
    const midi = new Map<string, string[]>();
    for (const owner of project.tracks) {
      for (const r of owner.modulations) {
        if (!r.enabled) continue;
        const src = project.tracks.find((t) => t.id === r.sourceTrackId);
        if (!src) continue;
        seen.add(r.id);
        let rn = this.nodes.get(r.id);
        const key = JSON.stringify(settingsOf(r));
        if (!rn || rn.route.source !== r.source) {
          if (rn) this.release(rn);
          const node = new AudioWorkletNode(this.ctx, MODSOURCE_PROCESSOR, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 2,
            channelCountMode: 'explicit',
            processorOptions: {
              settings: settingsOf(r),
              triggers: (initialTriggers?.get(r.sourceTrackId) ?? []).filter((n) => r.note === null || n.note === r.note).map((n) => n.time),
            },
          });
          const analyser = this.realtime ? new AnalyserNode(this.ctx, { fftSize: 32 }) : null;
          if (analyser) node.connect(analyser);
          rn = { route: r, ownerTrackId: owner.id, node, analyser, depthGains: [], tap: null, settingsKey: key };
          this.nodes.set(r.id, rn);
        } else if (rn.settingsKey !== key) {
          rn.node.port.postMessage({ type: 'settings', settings: settingsOf(r) });
          rn.settingsKey = key;
        }
        rn.route = r;
        rn.ownerTrackId = owner.id;
        this.wire(rn);
        if (r.source === 'midi') {
          const list = midi.get(r.sourceTrackId) ?? [];
          list.push(r.id);
          midi.set(r.sourceTrackId, list);
        }
      }
    }
    for (const [id, rn] of this.nodes) {
      if (!seen.has(id)) {
        this.release(rn);
        this.nodes.delete(id);
      }
    }
    this.midiBySource = midi;
  }

  /** (Re)connect a route: source tap → node → depth gains → target params. */
  private wire(rn: RouteNodes): void {
    const r = rn.route;
    // sidechain input
    if (rn.tap) {
      try {
        rn.tap.disconnect(rn.node);
      } catch {
        // already disconnected
      }
      rn.tap = null;
    }
    if (r.source === 'audio') {
      const tap = this.channel(r.sourceTrackId)?.sidechainTap() ?? null;
      if (tap) {
        tap.connect(rn.node);
        rn.tap = tap;
      }
    }
    // outputs
    for (const g of rn.depthGains) g.disconnect();
    rn.depthGains = [];
    const inputs = this.channel(rn.ownerTrackId)?.modulationInputs(r.target) ?? [];
    for (const inp of inputs) {
      const g = new GainNode(this.ctx, { gain: inp.scale(r.depth) });
      rn.node.connect(g);
      g.connect(inp.param);
      rn.depthGains.push(g);
    }
  }

  private release(rn: RouteNodes): void {
    if (rn.tap) {
      try {
        rn.tap.disconnect(rn.node);
      } catch {
        // already disconnected
      }
    }
    for (const g of rn.depthGains) g.disconnect();
    rn.node.port.postMessage({ type: 'dispose' });
    rn.node.disconnect();
    rn.analyser?.disconnect();
  }

  hasMidiRoutes(sourceTrackId: string): boolean {
    return (this.midiBySource.get(sourceTrackId)?.length ?? 0) > 0;
  }

  /** Note-ons (context seconds, −1 = now) from a source track; each route applies its note filter. */
  trigger(sourceTrackId: string, notes: { time: number; note: number }[]): void {
    const ids = this.midiBySource.get(sourceTrackId);
    if (!ids || notes.length === 0) return;
    for (const id of ids) {
      const rn = this.nodes.get(id);
      if (!rn) continue;
      const filter = rn.route.note;
      const times = notes.filter((n) => filter === null || n.note === filter).map((n) => n.time);
      if (times.length) rn.node.port.postMessage({ type: 'triggers', times });
    }
  }

  /** Drop future MIDI triggers (transport rescheduled or stopped). */
  cancel(time: number): void {
    for (const rn of this.nodes.values()) if (rn.route.source === 'midi') rn.node.port.postMessage({ type: 'cancel', time });
  }

  /** Current envelope value (0..1) of a route, for the UI. */
  level(routeId: string): number {
    const a = this.nodes.get(routeId)?.analyser;
    if (!a) return 0;
    a.getFloatTimeDomainData(this.buf);
    return Math.min(1, Math.max(0, this.buf[this.buf.length - 1] as number));
  }

  dispose(): void {
    for (const rn of this.nodes.values()) this.release(rn);
    this.nodes.clear();
  }
}
