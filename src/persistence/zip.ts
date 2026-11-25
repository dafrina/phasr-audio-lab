/**
 * Minimal ZIP container (pure; no dependencies).
 *
 * Writing uses the "stored" method (no compression): audio barely compresses
 * and stored entries keep export instant and streaming-friendly. Reading
 * supports stored and deflated entries (via DecompressionStream), so an
 * archive re-zipped by an OS tool can still be imported. No ZIP64 — entries
 * and archives must stay under 4 GB.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export class ZipFormatError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** DOS date/time for the entry headers. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function writeZip(entries: ZipEntry[], when = new Date()): Uint8Array<ArrayBuffer> {
  const { time, date } = dosTime(when);
  const parts: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
  let size = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    parts.push({ name, data: e.data, crc: crc32(e.data), offset: size });
    size += 30 + name.length + e.data.length;
  }
  const cdStart = size;
  for (const p of parts) size += 46 + p.name.length;
  const total = size + 22;
  if (total > 0xffffffff) throw new ZipFormatError('Archive is larger than 4 GB.');
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    v.setUint32(o, 0x04034b50, true); // local file header
    v.setUint16(o + 4, 20, true); // version needed
    v.setUint16(o + 6, 0x0800, true); // UTF-8 names
    v.setUint16(o + 8, 0, true); // stored
    v.setUint16(o + 10, time, true);
    v.setUint16(o + 12, date, true);
    v.setUint32(o + 14, p.crc, true);
    v.setUint32(o + 18, p.data.length, true);
    v.setUint32(o + 22, p.data.length, true);
    v.setUint16(o + 26, p.name.length, true);
    v.setUint16(o + 28, 0, true);
    out.set(p.name, o + 30);
    out.set(p.data, o + 30 + p.name.length);
    o += 30 + p.name.length + p.data.length;
  }
  for (const p of parts) {
    v.setUint32(o, 0x02014b50, true); // central directory header
    v.setUint16(o + 4, 20, true);
    v.setUint16(o + 6, 20, true);
    v.setUint16(o + 8, 0x0800, true);
    v.setUint16(o + 10, 0, true);
    v.setUint16(o + 12, time, true);
    v.setUint16(o + 14, date, true);
    v.setUint32(o + 16, p.crc, true);
    v.setUint32(o + 20, p.data.length, true);
    v.setUint32(o + 24, p.data.length, true);
    v.setUint16(o + 28, p.name.length, true);
    v.setUint32(o + 42, p.offset, true);
    out.set(p.name, o + 46);
    o += 46 + p.name.length;
  }
  v.setUint32(o, 0x06054b50, true); // end of central directory
  v.setUint16(o + 8, parts.length, true);
  v.setUint16(o + 10, parts.length, true);
  v.setUint32(o + 12, size - cdStart, true);
  v.setUint32(o + 16, cdStart, true);
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ZipFormatError('This browser cannot read compressed ZIP entries.');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read all entries. Verifies CRCs so a corrupted archive is reported, not half-loaded. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('Not a ZIP archive (no end-of-directory record).');
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (o + 46 > bytes.length || v.getUint32(o, true) !== 0x02014b50) throw new ZipFormatError('Corrupt ZIP central directory.');
    const method = v.getUint16(o + 10, true);
    const crc = v.getUint32(o + 16, true);
    const csize = v.getUint32(o + 20, true);
    const nameLen = v.getUint16(o + 28, true);
    const extraLen = v.getUint16(o + 30, true);
    const commentLen = v.getUint16(o + 32, true);
    const local = v.getUint32(o + 42, true);
    const name = dec.decode(bytes.subarray(o + 46, o + 46 + nameLen));
    o += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    if (v.getUint32(local, true) !== 0x04034b50) throw new ZipFormatError(`Corrupt entry header for ${name}.`);
    const lNameLen = v.getUint16(local + 26, true);
    const lExtraLen = v.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipFormatError(`Unsupported compression method ${method} for ${name}.`);
    if (crc32(data) !== crc) throw new ZipFormatError(`Checksum mismatch in ${name} — the archive is damaged.`);
    out.set(name, data);
  }
  return out;
}
