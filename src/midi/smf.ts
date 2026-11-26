/**
 * Standard MIDI File (.mid) reader — pure logic, shared by the UI and tests.
 *
 * Reads format 0 / 1 / 2 files: notes (with running status and
 * "note-on velocity 0" as note-off), track names, the first tempo and time
 * signature. Notes come back in quarter-note-relative ticks of the file and
 * are converted to the project's resolution by {@link midiToClipNotes}, so
 * they land on the same bars and beats whatever the file's tempo was.
 * Files timed in SMPTE frames are converted through their real-time
 * duration at the file's (or a default) tempo.
 */

export interface SmfNote {
  pitch: number;
  /** file ticks (quarter note = `ppq`) */
  start: number;
  length: number;
  /** 1..127 */
  velocity: number;
  channel: number;
}

export interface SmfTrack {
  name: string;
  notes: SmfNote[];
  /** MIDI channels the notes use (channel 9 = General MIDI drums) */
  channels: number[];
}

export interface SmfFile {
  format: number;
  /** ticks per quarter note */
  ppq: number;
  /** first tempo in the file (BPM), if any */
  bpm: number | null;
  timeSignature: { numerator: number; denominator: number } | null;
  /** tracks that contain notes, in file order */
  tracks: SmfTrack[];
}

export class MidiFileError extends Error {}

class Reader {
  pos = 0;
  constructor(
    readonly d: Uint8Array,
    readonly end = d.length,
  ) {}
  u8(): number {
    if (this.pos >= this.end) throw new MidiFileError('The MIDI file ends unexpectedly.');
    return this.d[this.pos++] as number;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new MidiFileError('Invalid variable-length number in the MIDI file.');
  }
  str(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

/** Parse a .mid file. Throws {@link MidiFileError} for anything that isn't one. */
export function parseMidiFile(buf: ArrayBuffer | Uint8Array): SmfFile {
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(d);
  // some files carry a RIFF ("RMID") wrapper: find the header chunk
  let start = 0;
  for (; start + 4 <= d.length && start < 4096; start++) if (d[start] === 0x4d && d[start + 1] === 0x54 && d[start + 2] === 0x68 && d[start + 3] === 0x64) break;
  if (start + 14 > d.length) throw new MidiFileError('This is not a MIDI file.');
  r.pos = start + 4;
  const hlen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.pos = start + 8 + hlen;
  if (format > 2) throw new MidiFileError(`Unsupported MIDI file format ${format}.`);
  // ticks per quarter, or SMPTE: frames/s × ticks/frame
  const smpte = (division & 0x8000) !== 0;
  const ticksPerSecond = smpte ? (256 - (division >> 8)) * (division & 0xff) : 0;
  const ppq = smpte ? 480 : division || 480;

  let bpm: number | null = null;
  let timeSignature: SmfFile['timeSignature'] = null;
  const tracks: SmfTrack[] = [];
  // SMPTE files: convert their absolute time to quarter notes at the first tempo (default 120)
  const raw: { name: string; notes: SmfNote[] }[] = [];

  for (let t = 0; t < ntracks && r.pos + 8 <= d.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const endPos = Math.min(d.length, r.pos + len);
    if (id !== 'MTrk') {
      r.pos = endPos; // unknown chunk: skip
      t--;
      continue;
    }
    const tr = new Reader(d, endPos);
    tr.pos = r.pos;
    r.pos = endPos;
    let tick = 0;
    let status = 0;
    let name = '';
    const notes: SmfNote[] = [];
    // open notes per channel+pitch (a stack: overlapping same-pitch notes close first-in-first-out)
    const open = new Map<number, { start: number; velocity: number }[]>();
    const close = (ch: number, pitch: number, at: number) => {
      const q = open.get(ch * 128 + pitch);
      const on = q?.shift();
      if (!on) return;
      notes.push({ pitch, start: on.start, length: Math.max(1, at - on.start), velocity: on.velocity, channel: ch });
    };
    try {
      while (tr.pos < endPos) {
        tick += tr.vlq();
        let b = tr.u8();
        if (b === 0xff) {
          const type = tr.u8();
          const mlen = tr.vlq();
          const mEnd = tr.pos + mlen;
          if (type === 0x03 && !name) name = tr.str(Math.min(mlen, 64)).replace(/\0/g, '').trim();
          else if (type === 0x51 && mlen >= 3 && bpm === null) {
            const us = (tr.u8() << 16) | (tr.u8() << 8) | tr.u8();
            if (us > 0) bpm = Math.round((60_000_000 / us) * 100) / 100;
          } else if (type === 0x58 && mlen >= 2 && !timeSignature) {
            timeSignature = { numerator: tr.u8(), denominator: 2 ** tr.u8() };
          } else if (type === 0x2f) break;
          tr.pos = mEnd;
          continue;
        }
        if (b === 0xf0 || b === 0xf7) {
          tr.pos += tr.vlq(); // sysex
          continue;
        }
        if (b < 0x80) {
          // running status: this byte is the first data byte
          if (!status) throw new MidiFileError('Corrupt MIDI track (data without a status byte).');
          tr.pos--;
          b = status;
        } else status = b;
        const kind = b & 0xf0;
        const ch = b & 0x0f;
        if (kind === 0x90 || kind === 0x80) {
          const pitch = tr.u8() & 0x7f;
          const vel = tr.u8() & 0x7f;
          if (kind === 0x90 && vel > 0) {
            const key = ch * 128 + pitch;
            const q = open.get(key) ?? [];
            q.push({ start: tick, velocity: vel });
            open.set(key, q);
          } else close(ch, pitch, tick);
        } else if (kind === 0xc0 || kind === 0xd0) tr.u8();
        else tr.pos += 2; // a0 b0 e0: two data bytes
      }
    } catch (e) {
      // a truncated or damaged track still yields the notes read so far
      if (!(e instanceof MidiFileError)) throw e;
    }
    // notes never released end at the track's last event
    for (const [key, q] of open) for (const on of q) notes.push({ pitch: key % 128, start: on.start, length: Math.max(1, tick - on.start), velocity: on.velocity, channel: Math.floor(key / 128) });
    raw.push({ name, notes });
  }

  const toQuarterTicks = (x: number) => (smpte ? Math.round(((x / ticksPerSecond) * (bpm ?? 120) * ppq) / 60) : x);
  raw.forEach(({ name, notes }) => {
    if (!notes.length) return;
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const conv = notes.map((n) => {
      const s = toQuarterTicks(n.start);
      return { ...n, start: s, length: Math.max(1, toQuarterTicks(n.start + n.length) - s) };
    });
    tracks.push({ name, notes: conv, channels: [...new Set(conv.map((n) => n.channel))].sort((a, b) => a - b) });
  });
  if (!tracks.length) throw new MidiFileError('The MIDI file contains no notes.');
  return { format, ppq, bpm, timeSignature, tracks };
}

export function isMidiFileName(name: string): boolean {
  return /\.(mid|midi|smf|kar|rmi)$/i.test(name);
}

/**
 * File notes → clip notes at the project's resolution. `offset` (project
 * ticks) is added to every start; `trimLeadIn` removes empty time before the
 * first note, rounded down to a whole bar, so a phrase that starts in bar 9
 * of its file doesn't land 8 bars late.
 */
export function midiToClipNotes(
  notes: readonly SmfNote[],
  filePpq: number,
  projectPpq: number,
  opts: { barTicks: number; trimLeadIn?: boolean; makeId: () => string },
): { id: string; pitch: number; start: number; length: number; velocity: number }[] {
  const k = projectPpq / filePpq;
  const first = notes.length ? Math.min(...notes.map((n) => n.start)) * k : 0;
  const shift = opts.trimLeadIn ? Math.floor(first / opts.barTicks) * opts.barTicks : 0;
  return notes.map((n) => ({
    id: opts.makeId(),
    pitch: n.pitch,
    start: Math.max(0, Math.round(n.start * k) - shift),
    length: Math.max(1, Math.round(n.length * k)),
    velocity: Math.min(127, Math.max(1, n.velocity)),
  }));
}

/**
 * Write a format-1 .mid file (tempo/time-signature track + one track per
 * entry). Used for tests today; the same bytes any DAW reads.
 */
export function writeMidiFile(opts: {
  ppq: number;
  bpm: number;
  timeSignature?: { numerator: number; denominator: number };
  tracks: { name: string; channel?: number; notes: { pitch: number; start: number; length: number; velocity: number }[] }[];
}): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const vlq = (buf: number[], v: number) => {
    const bytes = [v & 0x7f];
    while ((v >>>= 7)) bytes.unshift((v & 0x7f) | 0x80);
    buf.push(...bytes);
  };
  const chunk = (id: string, body: number[]) => {
    for (const c of id) out.push(c.charCodeAt(0));
    u32(body.length);
    out.push(...body);
  };
  out.push(0x4d, 0x54, 0x68, 0x64);
  u32(6);
  out.push(0, 1, 0, opts.tracks.length + 1, (opts.ppq >> 8) & 0x7f, opts.ppq & 0xff);
  const ts = opts.timeSignature ?? { numerator: 4, denominator: 4 };
  const us = Math.round(60_000_000 / opts.bpm);
  chunk('MTrk', [0, 0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff, 0, 0xff, 0x58, 4, ts.numerator, Math.round(Math.log2(ts.denominator)), 24, 8, 0, 0xff, 0x2f, 0]);
  for (const t of opts.tracks) {
    const ch = (t.channel ?? 0) & 0x0f;
    const evs: { t: number; on: boolean; p: number; v: number }[] = [];
    for (const n of t.notes) evs.push({ t: n.start, on: true, p: n.pitch, v: n.velocity }, { t: n.start + n.length, on: false, p: n.pitch, v: 0 });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on));
    const body: number[] = [0, 0xff, 0x03];
    const name = [...t.name].map((c) => c.charCodeAt(0) & 0x7f);
    vlq(body, name.length);
    body.push(...name);
    let last = 0;
    for (const e of evs) {
      vlq(body, e.t - last);
      last = e.t;
      body.push(e.on ? 0x90 | ch : 0x80 | ch, e.p & 0x7f, e.v & 0x7f);
    }
    body.push(0, 0xff, 0x2f, 0);
    chunk('MTrk', body);
  }
  return new Uint8Array(out);
}
