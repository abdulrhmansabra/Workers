import type { Env } from "./types";
import { safeError, safeLog } from "./utils";

const ADMOB_KEYS_URL = "https://www.gstatic.com/adsafeguard/prod-ssv-keys.json";
const ADMOB_KEYS_CACHE_KEY = "admob_ssv_keys";
const ADMOB_KEYS_TTL = 86400;

interface AdMobKey { keyId: string; pem: string; }

async function getAdMobKeys(env: Env): Promise<Map<string, CryptoKey>> {
  const cached = await env.KV_CACHE.get(ADMOB_KEYS_CACHE_KEY, "json") as { keys: AdMobKey[] } | null;
  if (cached?.keys?.length) {
    const keyMap = new Map<string, CryptoKey>();
    for (const entry of cached.keys) { try { keyMap.set(entry.keyId, await importRsaPublicKey(entry.pem)); } catch {} }
    if (keyMap.size > 0) return keyMap;
  }
  const resp = await fetch(ADMOB_KEYS_URL, { cf: { cacheTtl: 300 } });
  if (!resp.ok) { safeError("Failed to fetch AdMob keys", { status: resp.status }); throw new Error("ADMOB_KEYS_FETCH_FAILED"); }
  const raw = await resp.json() as { keys: Array<{ keyId: string; pem: string }> };
  const keys: AdMobKey[] = raw.keys.map((k) => ({ keyId: k.keyId, pem: k.pem }));
  await env.KV_CACHE.put(ADMOB_KEYS_CACHE_KEY, JSON.stringify({ keys, fetched_at: Date.now() }), { expirationTtl: ADMOB_KEYS_TTL });
  const keyMap = new Map<string, CryptoKey>();
  for (const entry of keys) { try { keyMap.set(entry.keyId, await importRsaPublicKey(entry.pem)); } catch {} }
  if (keyMap.size === 0) throw new Error("NO_VALID_ADMOB_KEYS");
  return keyMap;
}

async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("spki", bytes.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

export interface AdMobSSVParams { adNetwork: string; adUnit: string; rewardType: string; rewardAmount: number; timestamp: number; transactionId: string; userId: string; customData?: string; keyId: string; signature: string; }

export async function verifyAdMobSSV(url: URL, env: Env): Promise<AdMobSSVParams> {
  const params = url.searchParams;
  const keyId = params.get("key_id"); const signature = params.get("signature"); const transactionId = params.get("transaction_id");
  const userId = params.get("user_id"); const rewardAmountStr = params.get("reward_amount"); const timestampStr = params.get("timestamp");
  if (!keyId || !signature || !transactionId || !userId || !rewardAmountStr || !timestampStr) throw new SSVError("MISSING_PARAMS", "Missing required SSV parameters");
  const rewardAmount = parseFloat(rewardAmountStr); const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) throw new SSVError("INVALID_REWARD", "Invalid reward amount");
  const signedQuery = buildSignedQuery(url);
  const keys = await getAdMobKeys(env);
  let publicKey = keys.get(keyId);
  if (!publicKey) { await env.KV_CACHE.delete(ADMOB_KEYS_CACHE_KEY); const freshKeys = await getAdMobKeys(env); publicKey = freshKeys.get(keyId); if (!publicKey) throw new SSVError("UNKNOWN_KEY_ID", `Unknown key_id: ${keyId}`); }
  const sigBytes = base64UrlToBytes(signature);
  const dataBytes = new TextEncoder().encode(signedQuery);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sigBytes, dataBytes);
  if (!valid) throw new SSVError("INVALID_SIGNATURE", "SSV signature verification failed");
  safeLog("AdMob SSV verified", { transactionId, userId, rewardAmount });
  return { adNetwork: params.get("ad_network") ?? "", adUnit: params.get("ad_unit") ?? "", rewardType: params.get("reward_type") ?? "", rewardAmount, timestamp, transactionId, userId, customData: params.get("custom_data") ?? undefined, keyId, signature };
}

function buildSignedQuery(url: URL): string {
  return url.search.slice(1).split("&").filter((pair) => !pair.startsWith("signature=")).join("&");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const b64 = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class SSVError extends Error { constructor(public code: string, message: string) { super(message); this.name = "SSVError"; } }

export interface AdRewardSettings { reward_amount: number; daily_limit: number; daily_credit_cap: number; }
export const DEFAULT_AD_REWARD_SETTINGS: AdRewardSettings = { reward_amount: 5, daily_limit: 20, daily_credit_cap: 100 };

export async function checkDailyLimit(env: Env, uid: string, settings: AdRewardSettings): Promise<boolean> {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0); const startMs = startOfDay.getTime();
  const { queryCollection } = await import("./firestore");
  const recent = await queryCollection(env, "ad_rewards", [{ field: "uid", op: "==", value: uid }, { field: "created_at", op: ">=", value: startMs }], settings.daily_limit + 1);
  if (recent.length >= settings.daily_limit) return false;
  const totalCreditsToday = recent.reduce((sum, r) => sum + (r.data.reward_amount as number), 0);
  if (totalCreditsToday + settings.reward_amount > settings.daily_credit_cap) return false;
  return true;
}
