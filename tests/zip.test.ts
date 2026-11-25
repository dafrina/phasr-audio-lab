import { describe, expect, it } from 'vitest';
import { crc32, readZip, writeZip, ZipFormatError } from '../src/persistence/zip';

const enc = new TextEncoder();

describe('zip', () => {
  it('computes standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips entries including binary data and UTF-8 names', async () => {
    const bin = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
    const zip = writeZip([
      { name: 'project.json', data: enc.encode('{"a":1}') },
      { name: 'assets/ünï cödé.wav', data: bin },
      { name: 'empty.txt', data: new Uint8Array() },
    ]);
    const back = await readZip(zip);
    expect([...back.keys()]).toEqual(['project.json', 'assets/ünï cödé.wav', 'empty.txt']);
    expect(new TextDecoder().decode(back.get('project.json'))).toBe('{"a":1}');
    expect(back.get('assets/ünï cödé.wav')).toEqual(bin);
    expect(back.get('empty.txt')?.length).toBe(0);
  });

  it('reads deflated entries (archives re-zipped by other tools)', async () => {
    const text = 'hello hello hello hello '.repeat(100);
    const deflated = new Uint8Array(await new Response(new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    // build a stored zip, then patch the entry to "deflate" with the compressed payload
    const zip = writeZip([{ name: 'a.txt', data: deflated }]);
    const v = new DataView(zip.buffer);
    const crc = crc32(enc.encode(text));
    v.setUint16(8, 8, true); // local: method
    v.setUint32(14, crc, true);
    v.setUint32(22, text.length, true);
    const cd = v.getUint32(zip.length - 6, true);
    v.setUint16(cd + 10, 8, true);
    v.setUint32(cd + 16, crc, true);
    v.setUint32(cd + 24, text.length, true);
    const back = await readZip(zip);
    expect(new TextDecoder().decode(back.get('a.txt'))).toBe(text);
  });

  it('rejects non-zips and detects corruption', async () => {
    await expect(readZip(enc.encode('not a zip at all, sorry'))).rejects.toThrow(ZipFormatError);
    const zip = writeZip([{ name: 'x.bin', data: new Uint8Array([1, 2, 3, 4]) }]);
    zip[30 + 5 + 1] = 99; // flip a payload byte
    await expect(readZip(zip)).rejects.toThrow(/Checksum/);
  });
});
