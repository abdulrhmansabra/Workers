import type { DecodedIdToken, Env } from "./types";
import { safeError } from "./utils";

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
// Version the cache key because the previous implementation cached X.509 PEM certificates.
const JWKS_CACHE_KEY = "firebase_jwks_v2";
const DEFAULT_JWKS_CACHE_TTL = 3600;
const MAX_JWKS_CACHE_TTL = 6 * 60 * 60;

interface JwkKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

interface JwksDocument {
  keys: JwkKey[];
}

interface CachedJwks {
  keys: JwkKey[];
}

function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) {
    throw new AuthError("MALFORMED_TOKEN", "JWT contains invalid base64url data");
  }
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new AuthError("MALFORMED_TOKEN", "JWT contains invalid base64url data");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("MALFORMED_TOKEN", "JWT header or payload is not valid JSON");
  }
}

function getCacheTtl(response: Response): number {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const match = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return DEFAULT_JWKS_CACHE_TTL;
  const maxAge = Number(match[1]);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return DEFAULT_JWKS_CACHE_TTL;
  return Math.min(maxAge, MAX_JWKS_CACHE_TTL);
}

async function importJwksKeys(keys: JwkKey[]): Promise<Map<string, CryptoKey>> {
  const result = new Map<string, CryptoKey>();
  for (const key of keys) {
    if (key.kty !== "RSA" || key.alg && key.alg !== "RS256" || key.use && key.use !== "sig" ||
        typeof key.kid !== "string" || !key.kid || typeof key.n !== "string" || typeof key.e !== "string") {
      continue;
    }
    try {
      const imported = await crypto.subtle.importKey(
        "jwk",
        key as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      result.set(key.kid, imported);
    } catch {
      // Ignore malformed public keys; never log token or key material.
    }
  }
  return result;
}

async function getJwks(env: Env, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh) {
    const cached = await env.KV_CACHE.get(JWKS_CACHE_KEY, "json") as CachedJwks | null;
    if (cached?.keys?.length) {
      const imported = await importJwksKeys(cached.keys);
      if (imported.size > 0) return imported;
    }
  }

  const response = await fetch(JWKS_URL);
  if (!response.ok) {
    safeError("Failed to fetch Firebase public keys", { status: response.status });
    throw new Error("JWKS_FETCH_FAILED");
  }

  let document: JwksDocument;
  try {
    document = await response.json() as JwksDocument;
  } catch {
    throw new Error("JWKS_INVALID_RESPONSE");
  }
  if (!document || !Array.isArray(document.keys)) throw new Error("JWKS_INVALID_RESPONSE");

  const usableKeys = document.keys.filter((key) =>
    key && key.kty === "RSA" && typeof key.kid === "string" &&
    typeof key.n === "string" && typeof key.e === "string"
  );
  if (usableKeys.length === 0) throw new Error("NO_VALID_JWKS");

  const ttl = getCacheTtl(response);
  await env.KV_CACHE.put(JWKS_CACHE_KEY, JSON.stringify({ keys: usableKeys }), { expirationTtl: ttl });
  const imported = await importJwksKeys(usableKeys);
  if (imported.size === 0) throw new Error("NO_VALID_JWKS");
  return imported;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
  sub?: unknown;
  email?: unknown;
  firebase?: DecodedIdToken["firebase"];
  [key: string]: unknown;
}

export async function verifyIdToken(token: string, env: Env): Promise<DecodedIdToken> {
  if (typeof token !== "string" || !token || token.split(".").length !== 3) {
    throw new AuthError("MALFORMED_TOKEN", "ID token is malformed");
  }

  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const header = decodeJsonPart<JwtHeader>(headerPart);
  const payload = decodeJsonPart<JwtPayload>(payloadPart);

  if (header.alg !== "RS256") {
    throw new AuthError("UNSUPPORTED_ALG", "Unsupported token signing algorithm");
  }
  if (typeof header.kid !== "string" || !header.kid) {
    throw new AuthError("MISSING_KID", "Token header missing kid");
  }

  let keys = await getJwks(env);
  let publicKey = keys.get(header.kid);
  if (!publicKey) {
    // Rotate keys once when the token references a key not present in cache.
    keys = await getJwks(env, true);
    publicKey = keys.get(header.kid);
    if (!publicKey) throw new AuthError("UNKNOWN_KID", "Token signed with unknown key ID");
  }

  const signature = base64UrlDecode(signaturePart);
  const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      signedData,
    );
  } catch {
    throw new AuthError("INVALID_SIGNATURE", "Token signature verification failed");
  }
  if (!signatureValid) {
    throw new AuthError("INVALID_SIGNATURE", "Token signature verification failed");
  }

  // Claims are trusted only after the signature has been verified.
  const projectId = env.FIREBASE_PROJECT_ID;
  if (typeof projectId !== "string" || !projectId) {
    throw new AuthError("SERVER_CONFIG_ERROR", "Firebase project ID is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AuthError("INVALID_ISS", "Invalid Firebase token issuer");
  }
  if (payload.aud !== projectId) {
    throw new AuthError("INVALID_AUD", "Invalid Firebase token audience");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new AuthError("TOKEN_EXPIRED", "Firebase ID token has expired or has an invalid exp claim");
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > now + 60 || payload.iat < 0) {
    throw new AuthError("TOKEN_FUTURE", "Firebase ID token has an invalid iat claim");
  }
  if (typeof payload.auth_time !== "number" || !Number.isFinite(payload.auth_time) ||
      payload.auth_time < 0 || payload.auth_time > now + 60) {
    throw new AuthError("INVALID_AUTH_TIME", "Firebase ID token has an invalid auth_time claim");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new AuthError("INVALID_SUB", "Firebase token subject (uid) is invalid");
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    aud: payload.aud,
    iss: payload.iss,
    exp: payload.exp,
    iat: payload.iat,
    sub: payload.sub,
    firebase: payload.firebase,
  };
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}
