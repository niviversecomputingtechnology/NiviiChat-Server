import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "";
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN ?? "5m";
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN ?? "30d";

// NEXT_PHASE is "phase-production-build" during `next build`, when secrets
// aren't necessarily injected yet (e.g. the Docker build stage) — only
// enforce this once the app is actually serving traffic.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  (!ACCESS_SECRET || !REFRESH_SECRET)
) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set");
}

export interface AccessTokenPayload {
  sub: string;
  username: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

// --- Passwords ---

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- Access tokens (short-lived JWT, verified by both REST and WS) ---

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

// --- Refresh tokens ---
// Signed JWT (so tampering/expiry is caught without a DB round trip), with the
// compact token's hash also persisted in RefreshToken so it can be rotated
// on use and revoked on logout even before its JWT expiry elapses.

function parseDurationMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return value * unitMs[match[2]];
}

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: userId, jti } as RefreshTokenPayload, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN
  } as jwt.SignOptions);

  const expiresAt = new Date(Date.now() + parseDurationMs(REFRESH_EXPIRES_IN));
  await prisma.refreshToken.create({
    data: { token: hashToken(token), userId, expiresAt }
  });

  return token;
}

export async function rotateRefreshToken(
  rawToken: string
): Promise<{ userId: string; refreshToken: string } | null> {
  let payload: RefreshTokenPayload;
  try {
    payload = jwt.verify(rawToken, REFRESH_SECRET) as RefreshTokenPayload;
  } catch {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { token: tokenHash } });

  if (!existing || existing.userId !== payload.sub || existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
    return null;
  }

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() }
  });

  const refreshToken = await issueRefreshToken(existing.userId);
  return { userId: existing.userId, refreshToken };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { token: tokenHash, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}
