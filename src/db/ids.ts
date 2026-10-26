import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/** RFC 9562 UUIDv7: 48-bit Unix ms timestamp, then random bits. Monotonic within a process. */
export function uuidv7(now: number = Date.now()): string {
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    now = lastMs;
  } else {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE() & 0x7ff;
  }
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
