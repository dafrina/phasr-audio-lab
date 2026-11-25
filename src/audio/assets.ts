/**
 * In-memory registry of decoded audio assets and their peak caches.
 * The original encoded bytes are kept so the persistence layer can store
 * them losslessly (OPFS/IndexedDB) without re-encoding.
 */
import { createId } from '../core/ids';
import type { AssetRef } from '../project/types';
import { computePeaks, type PeakCache } from './peaks';

export interface LoadedAsset {
  ref: AssetRef;
  buffer: AudioBuffer;
  peaks: PeakCache;
  /** Original file bytes (or WAV-encoded recording) for persistence */
  bytes: ArrayBuffer | null;
  mime: string;
}

export class AssetDecodeError extends Error {}

export class AssetRegistry {
  private readonly assets = new Map<string, LoadedAsset>();
  private listeners = new Set<() => void>();
  private version = 0;

  get(id: string): LoadedAsset | undefined {
    return this.assets.get(id);
  }

  has(id: string): boolean {
    return this.assets.has(id);
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  async decodeBytes(ctx: BaseAudioContext, bytes: ArrayBuffer, name: string, mime: string, id?: string): Promise<LoadedAsset> {
    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches its input, so decode a copy and keep the original.
      buffer = await ctx.decodeAudioData(bytes.slice(0));
    } catch (e) {
      throw new AssetDecodeError(`Could not decode "${name}": ${e instanceof Error ? e.message : 'unsupported format'}`);
    }
    return this.addBuffer(buffer, name, bytes, mime, id);
  }

  addBuffer(buffer: AudioBuffer, name: string, bytes: ArrayBuffer | null, mime: string, id?: string): LoadedAsset {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const ref: AssetRef = {
      id: id ?? createId('ast'),
      name,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      durationSec: buffer.duration,
      frames: buffer.length,
    };
    const asset: LoadedAsset = { ref, buffer, peaks: computePeaks(channels, buffer.sampleRate), bytes, mime };
    this.assets.set(ref.id, asset);
    this.emit();
    return asset;
  }

  remove(id: string): void {
    if (this.assets.delete(id)) this.emit();
  }

  clear(): void {
    this.assets.clear();
    this.emit();
  }

  ids(): string[] {
    return [...this.assets.keys()];
  }
}
