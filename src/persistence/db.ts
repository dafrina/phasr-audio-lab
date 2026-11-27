/**
 * Local storage backends.
 *
 * IndexedDB holds project documents (JSON) and asset metadata. Audio bytes go
 * to the Origin Private File System when the browser supports writable OPFS
 * files from the main thread, and into IndexedDB otherwise. Both are
 * origin-private and survive reloads.
 */

const DB_NAME = 'phasr-audio-lab';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const ASSETS = 'assets';

export class StorageUnavailableError extends Error {}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
  clipCount: number;
  assetIds: string[];
  /** serialized Project */
  data: string;
}

export type ProjectMeta = Omit<ProjectRecord, 'data'>;

interface AssetRecord {
  id: string;
  mime: string;
  size: number;
  backend: 'opfs' | 'indexeddb';
  /** present only for the IndexedDB backend */
  bytes?: ArrayBuffer;
}

export interface StoredAsset {
  id: string;
  mime: string;
  bytes: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageUnavailableError('IndexedDB is not available in this browser.'));
      return;
    }
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new StorageUnavailableError(`Local storage is unavailable (${r.error?.message ?? 'blocked'}). Projects can't be saved in this browser session — export an archive instead.`));
    r.onblocked = () => reject(new StorageUnavailableError('Storage is blocked by another open tab of this app. Close it and reload.'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

/**
 * Run one write and wait until its transaction has *committed*. A request's
 * success only means it was queued: a full disk (quota) is reported as the
 * transaction aborting afterwards, and then nothing was stored.
 */
async function write(name: string, op: (s: IDBObjectStore) => IDBRequest): Promise<void> {
  const s = await store(name, 'readwrite');
  const tx = s.transaction;
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('The write was aborted before it was stored.', 'AbortError'));
  });
  await Promise.all([req(op(s)), committed]);
}

/** Is this the browser saying storage is full? (By name: the message text differs between browsers.) */
export function isQuotaError(e: unknown): boolean {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) return true;
  return /quota/i.test(e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function putProjectRecord(rec: ProjectRecord): Promise<void> {
  await write(PROJECTS, (s) => s.put(rec));
}

export async function getProjectRecord(id: string): Promise<ProjectRecord | null> {
  return ((await req((await store(PROJECTS, 'readonly')).get(id))) as ProjectRecord | undefined) ?? null;
}

export async function deleteProjectRecord(id: string): Promise<void> {
  await write(PROJECTS, (s) => s.delete(id));
}

export async function listProjectRecords(): Promise<ProjectMeta[]> {
  const all = (await req((await store(PROJECTS, 'readonly')).getAll())) as ProjectRecord[];
  return all.map(({ data: _data, ...meta }) => meta).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

let opfsDir: Promise<FileSystemDirectoryHandle | null> | null = null;

/** OPFS assets directory if writable files are supported here, else null. */
function opfs(): Promise<FileSystemDirectoryHandle | null> {
  opfsDir ??= (async () => {
    try {
      const root = await navigator.storage?.getDirectory?.();
      if (!root) return null;
      const dir = await root.getDirectoryHandle('assets', { create: true });
      // probe: some browsers expose OPFS but not createWritable on the main thread
      const probe = await dir.getFileHandle('.probe', { create: true });
      if (typeof (probe as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== 'function') return null;
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      return dir;
    } catch {
      return null;
    }
  })();
  return opfsDir;
}

export async function assetBackend(): Promise<'opfs' | 'indexeddb'> {
  return (await opfs()) ? 'opfs' : 'indexeddb';
}

export async function hasAsset(id: string): Promise<boolean> {
  return ((await req((await store(ASSETS, 'readonly')).getKey(id))) ?? null) !== null;
}

export async function putAsset(a: StoredAsset): Promise<void> {
  const dir = await opfs();
  if (dir) {
    const fh = await dir.getFileHandle(a.id, { create: true });
    const w = await fh.createWritable();
    await w.write(a.bytes);
    await w.close();
    const rec: AssetRecord = { id: a.id, mime: a.mime, size: a.bytes.byteLength, backend: 'opfs' };
    await write(ASSETS, (s) => s.put(rec));
  } else {
    const rec: AssetRecord = { id: a.id, mime: a.mime, size: a.bytes.byteLength, backend: 'indexeddb', bytes: a.bytes };
    await write(ASSETS, (s) => s.put(rec));
  }
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  const rec = (await req((await store(ASSETS, 'readonly')).get(id))) as AssetRecord | undefined;
  if (!rec) return null;
  if (rec.backend === 'indexeddb') return rec.bytes ? { id, mime: rec.mime, bytes: rec.bytes } : null;
  const dir = await opfs();
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(id)).getFile();
    return { id, mime: rec.mime, bytes: await file.arrayBuffer() };
  } catch {
    return null; // metadata exists but the file is gone
  }
}

export async function deleteAsset(id: string): Promise<void> {
  const rec = (await req((await store(ASSETS, 'readonly')).get(id))) as AssetRecord | undefined;
  if (rec?.backend === 'opfs') {
    const dir = await opfs();
    await dir?.removeEntry(id).catch(() => undefined);
  }
  await write(ASSETS, (s) => s.delete(id));
}

export async function listAssetIds(): Promise<string[]> {
  return ((await req((await store(ASSETS, 'readonly')).getAllKeys())) as IDBValidKey[]).map(String);
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
