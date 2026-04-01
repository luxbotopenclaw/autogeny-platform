/**
 * Auth Bridge: POST /api/auth/bridge
 *
 * Accepts an Autogeny JWT (HS256, signed with AUTOGENY_JWT_SECRET),
 * upserts the user into better-auth's authUsers table, creates a session,
 * and returns a Paperclip session token.
 */
import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { authUsers, authSessions } from "@paperclipai/db";

// ─── In-memory rate limiter ───────────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSecs: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterSecs: 0 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSecs: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true, retryAfterSecs: 0 };
}

// ─── JWT helpers (no external dep — uses node:crypto) ───────────────────────

interface JwtPayload {
  sub?: string;
  userId?: string;
  email?: string;
  name?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const normalized = pad === 0 ? padded : padded + "=".repeat(4 - pad);
  return Buffer.from(normalized, "base64");
}

function verifyAutogenyJwt(token: string, secretB64: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT structure");

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify algorithm
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as { alg?: string };
  if (header.alg !== "HS256") throw new Error(`Unsupported algorithm: ${header.alg}`);

  // Decode secret — try base64 first, fall back to raw string
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretB64, "base64");
    // Verify it's a reasonable decoded length (≥16 bytes means valid base64 key)
    if (secretBytes.length < 16) {
      secretBytes = Buffer.from(secretB64, "utf8");
    }
  } catch {
    secretBytes = Buffer.from(secretB64, "utf8");
  }

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", secretBytes).update(signingInput).digest("base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  const actualBuf = base64UrlDecode(sigB64);

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error("Invalid JWT signature");
  }

  // Decode payload
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as JwtPayload;

  // Check expiry — require exp to be present; reject if missing or expired
  if (typeof payload.exp !== "number") {
    throw new Error("JWT missing exp claim");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT expired");
  }

  return payload;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function authBridgeRouter(db: Db): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    // Rate limiting
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";

    const { allowed, retryAfterSecs } = checkRateLimit(ip);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfterSecs));
      res.status(429).json({ error: "rate_limit_exceeded", retryAfterSecs });
      return;
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(400).json({ error: "missing_authorization", message: "Authorization: Bearer <token> header required" });
      return;
    }
    const token = authHeader.slice(7).trim();

    // Get secret from environment
    const secretB64 = process.env.AUTOGENY_JWT_SECRET;
    if (!secretB64) {
      res.status(500).json({ error: "server_misconfiguration" });
      return;
    }

    // Verify JWT
    let payload: JwtPayload;
    try {
      payload = verifyAutogenyJwt(token, secretB64);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(401).json({ error: "invalid_token", message });
      return;
    }

    // Extract user identity
    const userId = payload.sub ?? payload.userId;
    if (!userId) {
      res.status(401).json({ error: "invalid_token", message: "JWT missing sub/userId claim" });
      return;
    }
    const email = payload.email ?? `${userId}@autogeny.bridge`;
    const name = payload.name ?? email.split("@")[0] ?? "Autogeny User";

    try {
      const now = new Date();

      // Upsert user in authUsers
      await db
        .insert(authUsers)
        .values({
          id: userId,
          email,
          name,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: authUsers.id,
          set: {
            email,
            name,
            updatedAt: now,
          },
        });

      // Create a new session (30-day expiry)
      const sessionId = randomUUID();
      const sessionToken = randomUUID();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      await db.insert(authSessions).values({
        id: sessionId,
        token: sessionToken,
        userId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });

      res.status(200).json({
        sessionToken,
        userId,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown DB error";
      console.error("[auth-bridge] DB error:", message);
      res.status(500).json({ error: "internal_error" });
    }
  });

  return router;
}
