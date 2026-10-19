import type { DecodedIdToken, Env } from "./types";
import { safeError, safeLog } from "./utils";

const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const JWKS_CACHE_KEY = "firebase_jwks_v1";
const JWKS_CACHE_TTL = 3600;

interface JwkKey { kid: string; pem: string; }

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const b64 = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getJwks(env: Env): Promise<Map<string, CryptoKey>> {
  const cached = await env.KV_CACHE.get(JWKS_CACHE_KEY, "json") as { keys: JwkKey[] } | null;
  if (cached?.keys?.length) {
    const keyMap = new Map<string, CryptoKey>();
    for (const entry of cached.keys) {
      try {
        const key = await crypto.subtle.importKey("spki", pemToDer(entry.pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        keyMap.set(entry.kid, key);
      } catch {}
    }
    if (keyMap.size > 0) return keyMap;
  }
  const resp = await fetch(JWKS_URL, { cf: { cacheTtl: 300 } });
  if (!resp.ok) { safeError("Failed to fetch Firebase JWKS", { status: resp.status }); throw new Error("JWKS_FETCH_FAILED"); }
  const raw = await resp.json() as Record<string, string>;
  const keys: JwkKey[] = Object.entries(raw).map(([kid, pem]) => ({ kid, pem }));
  await env.KV_CACHE.put(JWKS_CACHE_KEY, JSON.stringify({ keys, fetched_at: Date.now() }), { expirationTtl: JWKS_CACHE_TTL });
  const keyMap = new Map<string, CryptoKey>();
  for (const entry of keys) {
    try {
      const key = await crypto.subtle.importKey("spki", pemToDer(entry.pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keyMap.set(entry.kid, key);
    } catch {}
  }
  if (keyMap.size === 0) throw new Error("NO_VALID_JWKS");
  return keyMap;
}

interface JwtHeader { alg: string; kid: string; typ?: string; }
interface JwtPayload { iss: string; aud: string; exp: number; iat: number; sub: string; email?: string; firebase?: { sign_in_provider?: string; identities?: Record<string, unknown> }; [key: string]: unknown; }

function decodeJwtPart<T>(part: string): T {
  const bytes = base64UrlDecode(part);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function verifyIdToken(token: string, env: Env): Promise<DecodedIdToken> {
  if (!token || token.split(".").length !== 3) throw new AuthError("MALFORMED_TOKEN", "ID token is malformed");
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  const header = decodeJwtPart<JwtHeader>(headerB64);
  const payload = decodeJwtPart<JwtPayload>(payloadB64);
  if (header.alg !== "RS256") throw new AuthError("UNSUPPORTED_ALG", `Unsupported algorithm: ${header.alg}`);
  if (!header.kid) throw new AuthError("MISSING_KID", "Token header missing kid");
  const expectedIss = `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`;
  if (payload.iss !== expectedIss) throw new AuthError("INVALID_ISS", `Invalid issuer. Expected ${expectedIss}`);
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new AuthError("INVALID_AUD", `Invalid audience. Expected ${env.FIREBASE_PROJECT_ID}`);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new AuthError("TOKEN_EXPIRED", "ID token has expired");
  if (payload.iat > now + 60) throw new AuthError("TOKEN_FUTURE", "ID token issued in the future");
  if (!payload.sub || typeof payload.sub !== "string" || payload.sub.length === 0) throw new AuthError("INVALID_SUB", "Token subject (uid) is missing or empty");
  const jwks = await getJwks(env);
  let publicKey = jwks.get(header.kid);
  if (!publicKey) {
    safeLog("JWKS key not found, forcing refresh", { kid: header.kid });
    await env.KV_CACHE.delete(JWKS_CACHE_KEY);
    const freshJwks = await getJwks(env);
    publicKey = freshJwks.get(header.kid);
    if (!publicKey) throw new AuthError("UNKNOWN_KID", "Token signed with unknown key ID");
  }
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedData);
  if (!valid) throw new AuthError("INVALID_SIGNATURE", "Token signature verification failed");
  return { uid: payload.sub, email: payload.email, aud: payload.aud, iss: payload.iss, exp: payload.exp, iat: payload.iat, sub: payload.sub, firebase: payload.firebase };
}

export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AuthError"; }
}
