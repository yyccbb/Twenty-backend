import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from node:crypto, so no native dependency. Parameters are stored with each hash so they can be raised later.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keyLen, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Returns `scrypt$N$r$p$<salt b64url>$<key b64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/** Verified against when the email is unknown, so a failed sign-in takes the same time either way. */
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
