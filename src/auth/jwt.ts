import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';

const AUDIENCE = 'twenty-api';
const key = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);

export async function signAccessToken(config: Config, userId: string, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + config.ACCESS_TOKEN_TTL_SECONDS)
    .sign(key(config));
}

export async function verifyAccessToken(config: Config, token: string, now: Date): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key(config), {
      issuer: config.JWT_ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (!payload.sub) throw new Error('no subject');
    return payload.sub;
  } catch {
    throw new AppError(401, 'invalid_token', 'The access token is invalid or expired');
  }
}
