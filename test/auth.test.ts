import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { AuthError, verifyIdToken } from "../src/auth";

const PROJECT_ID = "aishorts-57d93";
const KEY_ID = "test-firebase-key";

let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string; alg: string; use: string };

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 20,
    sub: "test-user-uid",
    email: "test@example.com",
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  };
}

async function signToken(
  claims: Record<string, unknown> = createClaims(),
  options: { kid?: string; key?: CryptoKey; alg?: string } = {},
): Promise<string> {
  const header = {
    alg: options.alg ?? "RS256",
    kid: options.kid ?? KEY_ID,
    typ: "JWT",
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const input = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signingKey,
    input,
  );
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function createEnv(): Env {
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return {
    FIREBASE_PROJECT_ID: PROJECT_ID,
    KV_CACHE: kv,
  } as unknown as Env;
}

function mockJwksFetch(jwk = publicJwk) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  signingKey = pair.privateKey;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk = { ...exported, kid: KEY_ID, alg: "RS256", use: "sig" } as JsonWebKey & { kid: string; alg: string; use: string };

  const otherPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  otherSigningKey = otherPair.privateKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyIdToken", () => {
  it("accepts a correctly signed Firebase ID token", async () => {
    mockJwksFetch();
    const token = await signToken();
    const decoded = await verifyIdToken(token, createEnv());

    expect(decoded.uid).toBe("test-user-uid");
    expect(decoded.email).toBe("test@example.com");
    expect(decoded.aud).toBe(PROJECT_ID);
    expect(decoded.iss).toBe(`https://securetoken.google.com/${PROJECT_ID}`);
  });

  it("rejects a token signed by a different private key", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims(), { key: otherSigningKey });
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects an invalid audience", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims({ aud: "another-project" }));
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "INVALID_AUD" });
  });

  it("rejects an invalid issuer", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims({ iss: "https://securetoken.google.com/another-project" }));
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "INVALID_ISS" });
  });

  it("rejects an expired token", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims({ exp: Math.floor(Date.now() / 1000) - 1 }));
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("rejects an iat claim too far in the future", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims({ iat: Math.floor(Date.now() / 1000) + 600 }));
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "TOKEN_FUTURE" });
  });

  it("rejects a token with an unknown kid after one forced key refresh", async () => {
    const fetchMock = mockJwksFetch();
    const token = await signToken(createClaims(), { kid: "unknown-key-id" });
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "UNKNOWN_KID" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed JWT structures without fetching keys", async () => {
    const fetchMock = mockJwksFetch();
    await expect(verifyIdToken("not-a-jwt", createEnv())).rejects.toBeInstanceOf(AuthError);
    await expect(verifyIdToken("a.b", createEnv())).rejects.toMatchObject({ code: "MALFORMED_TOKEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported algorithm", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims(), { alg: "HS256" });
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "UNSUPPORTED_ALG" });
  });

  it("rejects an invalid auth_time claim", async () => {
    mockJwksFetch();
    const token = await signToken(createClaims({ auth_time: Math.floor(Date.now() / 1000) + 600 }));
    await expect(verifyIdToken(token, createEnv())).rejects.toMatchObject({ code: "INVALID_AUTH_TIME" });
  });
});
