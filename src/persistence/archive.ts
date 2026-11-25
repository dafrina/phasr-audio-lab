/**
 * Portable project archive (.phasr): a ZIP containing
 *   manifest.json   — format/version, the full project, and an asset table
 *   assets/<id>.<ext> — every audio file the project references (original bytes)
 * Pure apart from the ZIP reader's optional DecompressionStream use.
 */
import { createId } from '../core/ids';
import { migrateProject } from '../project/migrations';
import type { Project } from '../project/types';
import { readZip, writeZip, type ZipEntry } from './zip';

export const ARCHIVE_FORMAT = 'phasr-archive';
export const ARCHIVE_VERSION = 1;

export interface ArchiveAsset {
  id: string;
  mime: string;
  bytes: Uint8Array;
}

interface ManifestAsset {
  id: string;
  file: string;
  mime: string;
  name: string;
}

interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  app: string;
  exportedAt: string;
  project: Project;
  assets: ManifestAsset[];
}

export class ArchiveFormatError extends Error {}

const EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

export function extForMime(mime: string): string {
  return EXT[mime.toLowerCase()] ?? 'bin';
}

export function buildArchive(project: Project, assets: ArchiveAsset[], now = new Date()): Uint8Array<ArrayBuffer> {
  const table: ManifestAsset[] = assets.map((a) => ({
    id: a.id,
    file: `assets/${a.id}.${extForMime(a.mime)}`,
    mime: a.mime,
    name: project.assets[a.id]?.name ?? a.id,
  }));
  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    app: 'PHASR Audio Lab',
    exportedAt: now.toISOString(),
    project,
    assets: table,
  };
  const entries: ZipEntry[] = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) }];
  assets.forEach((a, i) => entries.push({ name: (table[i] as ManifestAsset).file, data: a.bytes }));
  return writeZip(entries, now);
}

export interface ParsedArchive {
  project: Project;
  assets: ArchiveAsset[];
  /** asset ids the project references but the archive doesn't contain */
  missing: string[];
}

/**
 * Parse and validate an archive. The project gets a new id so importing never
 * overwrites an existing project; asset ids are kept (they're unique and the
 * content is immutable).
 */
export async function parseArchive(bytes: Uint8Array): Promise<ParsedArchive> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch (e) {
    throw new ArchiveFormatError(`This file isn't a valid project archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mf = files.get('manifest.json');
  if (!mf) throw new ArchiveFormatError('The archive has no manifest.json — it was not created by PHASR Audio Lab.');
  let manifest: Partial<Manifest>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(mf)) as Partial<Manifest>;
  } catch {
    throw new ArchiveFormatError('The archive manifest is not valid JSON.');
  }
  if (manifest.format !== ARCHIVE_FORMAT) throw new ArchiveFormatError('Not a PHASR project archive.');
  if (typeof manifest.version === 'number' && manifest.version > ARCHIVE_VERSION) {
    throw new ArchiveFormatError(`This archive was made by a newer version (archive v${manifest.version}).`);
  }
  const project = migrateProject(manifest.project);
  const assets: ArchiveAsset[] = [];
  for (const a of Array.isArray(manifest.assets) ? manifest.assets : []) {
    if (!a || typeof a.id !== 'string' || typeof a.file !== 'string') continue;
    const data = files.get(a.file);
    if (data) assets.push({ id: a.id, mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream', bytes: data });
  }
  const have = new Set(assets.map((a) => a.id));
  const missing = Object.keys(project.assets).filter((id) => !have.has(id));
  return { project: { ...project, id: createId('prj') }, assets, missing };
}
