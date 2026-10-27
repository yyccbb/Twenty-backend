import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { type Tx, transaction } from '../db/client.js';
import { uuidv7 } from '../db/ids.js';
import { refreshTokens, userSettings, users } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { addDays, iso } from '../lib/time.js';
import { assertSupportedTimezone } from '../services/users.js';
import { signAccessToken } from './jwt.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

async function issueSession(deps: Deps, tx: Tx, userId: string, deviceLabel: string | null) {
  const now = deps.clock.now();
  const raw = randomBytes(32).toString('base64url');
  const id = uuidv7();
  const expiresAt = addDays(now, deps.config.REFRESH_TOKEN_TTL_DAYS);
  await tx.db.insert(refreshTokens).values({ id, userId, tokenHash: hashToken(raw), deviceLabel, createdAt: now, expiresAt });
  return {
    id,
    body: {
      access_token: await signAccessToken(deps.config, userId, now),
      token_type: 'Bearer' as const,
      expires_in: deps.config.ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: raw,
      refresh_expires_at: iso(expiresAt),
      user_id: userId,
    },
  };
}

interface NewUserInput {
  display_name?: string | null;
  timezone?: string;
}

/** Inserts the user and their default settings; returns null if a concurrent request created it first. */
async function createUser(
  deps: Deps,
  tx: Tx,
  identity: { appleSub: string } | { email: string; passwordHash: string },
  input: NewUserInput,
) {
  const [user] = await tx.db
    .insert(users)
    .values({
      id: uuidv7(),
      ...identity,
      displayName: input.display_name ?? null,
      timezone: input.timezone ?? 'UTC',
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .returning();
  if (user) await tx.db.insert(userSettings).values({ userId: user.id });
  return user ?? null;
}

export interface AppleSignInInput extends NewUserInput {
  id_token: string;
  nonce?: string | null;
  device_label?: string | null;
}

/** Exchanges an Apple ID token for our own tokens, creating the user on first sign-in. */
export async function signInWithApple(deps: Deps, input: AppleSignInInput) {
  if (input.timezone) assertSupportedTimezone(input.timezone);
  const identity = await deps.apple.verify(input.id_token, input.nonce ?? null);
  return transaction(deps.database, async (tx) => {
    let [user] = await tx.db
      .select()
      .from(users)
      .where(and(eq(users.appleSub, identity.sub), isNull(users.deletedAt)))
      .for('update');
    let created = false;
    if (!user) {
      user = (await createUser(deps, tx, { appleSub: identity.sub }, input)) ?? undefined;
      if (!user) throw new AppError(409, 'sign_in_conflict', 'Concurrent sign-in; retry');
      created = true;
    }
    const session = await issueSession(deps, tx, user.id, input.device_label ?? null);
    return { ...session.body, created };
  });
}

/** Email accounts are separate from Apple accounts, even when the addresses match. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface EmailSignUpInput extends NewUserInput {
  email: string;
  password: string;
  device_label?: string | null;
}

/** Creates an email + password account. The address is not verified (MVP). */
export async function signUpWithEmail(deps: Deps, input: EmailSignUpInput) {
  if (input.timezone) assertSupportedTimezone(input.timezone);
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  return transaction(deps.database, async (tx) => {
    const user = await createUser(deps, tx, { email, passwordHash }, input);
    if (!user) throw new AppError(409, 'email_taken', 'An account with this email already exists');
    const session = await issueSession(deps, tx, user.id, input.device_label ?? null);
    return session.body;
  });
}

export interface EmailSignInInput {
  email: string;
  password: string;
  device_label?: string | null;
}

export async function signInWithEmail(deps: Deps, input: EmailSignInInput) {
  const [user] = await deps.database.db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.email, normalizeEmail(input.email)), isNull(users.deletedAt)));
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyPasswordHash()));
  if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'The email or password is incorrect');
  return transaction(deps.database, async (tx) => (await issueSession(deps, tx, user.id, input.device_label ?? null)).body);
}

/**
 * Rotates a refresh token. Presenting an already-rotated token means it leaked or was replayed,
 * so every session of that user is revoked.
 */
export async function refreshSession(deps: Deps, rawToken: string) {
  const now = deps.clock.now();
  const result = await transaction(deps.database, async (tx) => {
    const [row] = await tx.db
      .select({ token: refreshTokens, deletedAt: users.deletedAt })
      .from(refreshTokens)
      .innerJoin(users, eq(users.id, refreshTokens.userId))
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)))
      .for('update', { of: refreshTokens });
    if (!row || row.deletedAt) return { error: 'invalid_refresh_token' as const };
    const { token } = row;
    if (token.revokedAt) {
      await tx.db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, token.userId), isNull(refreshTokens.revokedAt)));
      logger.warn({ userId: token.userId, tokenId: token.id }, 'refresh token reuse detected; all sessions revoked');
      return { error: 'refresh_token_reused' as const };
    }
    if (token.expiresAt.getTime() <= now.getTime()) return { error: 'invalid_refresh_token' as const };
    const next = await issueSession(deps, tx, token.userId, token.deviceLabel);
    await tx.db.update(refreshTokens).set({ revokedAt: now, replacedById: next.id }).where(eq(refreshTokens.id, token.id));
    return { body: next.body };
  });
  // Errors are returned rather than thrown so the reuse revocation above commits.
  if ('error' in result) {
    throw new AppError(
      401,
      result.error!,
      result.error === 'refresh_token_reused' ? 'Refresh token reuse detected; sign in again' : 'The refresh token is invalid or expired',
    );
  }
  return result.body;
}

export async function logout(deps: Deps, rawToken: string) {
  await deps.database.db
    .update(refreshTokens)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(rawToken)), isNull(refreshTokens.revokedAt)));
}
