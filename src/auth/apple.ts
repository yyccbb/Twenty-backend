import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../lib/errors.js';

export interface AppleIdentity {
  sub: string;
  email: string | null;
}

export interface AppleVerifier {
  verify(idToken: string, nonce: string | null): Promise<AppleIdentity>;
}

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = new URL('https://appleid.apple.com/auth/keys');

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Verifies a Sign in with Apple ID token against Apple's published keys. */
export class JoseAppleVerifier implements AppleVerifier {
  private readonly jwks = createRemoteJWKSet(APPLE_JWKS, { cooldownDuration: 60_000, cacheMaxAge: 3_600_000 });

  constructor(private readonly audiences: string[]) {}

  async verify(idToken: string, nonce: string | null): Promise<AppleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, { issuer: APPLE_ISSUER, audience: this.audiences }));
    } catch {
      throw new AppError(401, 'invalid_apple_token', 'The Apple ID token is invalid or expired');
    }
    // iOS sends Apple the SHA-256 of the raw nonce and the server the raw nonce; web flows pass it as-is.
    if (nonce !== null && payload.nonce !== sha256Hex(nonce) && payload.nonce !== nonce) {
      throw new AppError(401, 'invalid_apple_token', 'The Apple ID token nonce does not match');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new AppError(401, 'invalid_apple_token', 'The Apple ID token has no subject');
    }
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  }
}
