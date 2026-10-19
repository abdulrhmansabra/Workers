import type { Env, AuthContext } from "../types";
import { verifyIdToken, AuthError } from "../auth";
import { errorResponse, extractBearerToken, rateLimit, HttpError } from "../utils";

export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
  const token = extractBearerToken(request);
  if (!token) throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid Authorization header");

  const tokenHash = await sha256(token);
  if (!rateLimit(`auth:${tokenHash}`, 30, 60_000)) {
    throw new HttpError(429, "RATE_LIMITED", "Too many authentication attempts");
  }

  try {
    const decoded = await verifyIdToken(token, env);
    return { uid: decoded.uid, email: decoded.email, token: decoded };
  } catch (err) {
    if (err instanceof AuthError) throw new HttpError(401, err.code, err.message);
    throw new HttpError(401, "AUTH_FAILED", "Token verification failed");
  }
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
