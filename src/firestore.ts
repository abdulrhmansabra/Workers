import type { Env } from "./types";
import { safeError } from "./utils";

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface ServiceAccount { type: string; project_id: string; private_key: string; client_email: string; token_uri: string; client_id?: string; }

const TOKEN_CACHE_KEY = "firestore_oauth_token";
const TOKEN_TTL = 3300;

async function getServiceAccount(env: Env): Promise<ServiceAccount> {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is not set");
  try { return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount; }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"); }
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey("pkcs8", bytes.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.KV_CACHE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;
  const sa = await getServiceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const assertion = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform", aud: OAUTH_TOKEN_URL, exp: now + 3600, iat: now };
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(assertion)));
  const signInput = `${headerB64}.${payloadB64}`;
  const privateKey = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  const resp = await fetch(OAUTH_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!resp.ok) { safeError("OAuth token request failed", { status: resp.status }); throw new Error(`OAUTH_FAILED: ${resp.status}`); }
  const data = await resp.json() as { access_token: string; expires_in: number };
  await env.KV_CACHE.put(TOKEN_CACHE_KEY, data.access_token, { expirationTtl: Math.min(data.expires_in - 60, TOKEN_TTL) });
  return data.access_token;
}

function docPath(env: Env, path: string): string { return `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`; }
function commitPath(env: Env): string { return `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`; }
function transactionPath(env: Env): string { return `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:beginTransaction`; }
function runQueryPath(env: Env): string { return `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`; }

export type FirestoreValue = { valueType: string } & Record<string, unknown>;

export function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") { if (Number.isInteger(value)) return { integerValue: String(value) }; return { doubleValue: value }; }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => toFirestoreValue(v)) } };
  if (typeof value === "object" && value !== null) { const fields: Record<string, FirestoreValue> = {}; for (const [k, v] of Object.entries(value)) fields[k] = toFirestoreValue(v); return { mapValue: { fields } }; }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

export function fromFirestoreValue(value: FirestoreValue): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (value.nullValue !== undefined) return null;
  if (value.booleanValue !== undefined) return value.booleanValue as boolean;
  if (value.integerValue !== undefined) return parseInt(value.integerValue as string, 10);
  if (value.doubleValue !== undefined) return value.doubleValue as number;
  if (value.stringValue !== undefined) return value.stringValue as string;
  if (value.timestampValue !== undefined) return new Date(value.timestampValue as string).getTime();
  if (value.arrayValue !== undefined) return ((value.arrayValue as { values?: FirestoreValue[] }).values ?? []).map(fromFirestoreValue);
  if (value.mapValue !== undefined) { const fields = (value.mapValue as { fields?: Record<string, FirestoreValue> }).fields; if (!fields) return {}; const obj: Record<string, unknown> = {}; for (const [k, v] of Object.entries(fields)) obj[k] = fromFirestoreValue(v); return obj; }
  return undefined;
}

export function fromFirestoreDoc(doc: { name?: string; fields?: Record<string, FirestoreValue> }): { id: string; data: Record<string, unknown> } | null {
  if (!doc.fields) return null;
  const nameParts = doc.name?.split("/") ?? [];
  const id = nameParts[nameParts.length - 1] ?? "";
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields)) data[k] = fromFirestoreValue(v);
  return { id, data };
}

export async function getDoc(env: Env, path: string, transaction?: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const token = await getAccessToken(env);
  const url = transaction ? `${docPath(env, path)}?transaction=${transaction}` : docPath(env, path);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) { safeError("Firestore getDoc failed", { path, status: resp.status }); throw new Error(`FIRESTORE_GET_FAILED: ${resp.status}`); }
  return fromFirestoreDoc(await resp.json() as { name?: string; fields?: Record<string, FirestoreValue> });
}

/**
 * Read multiple Firestore documents with the REST batchGet endpoint.
 * Firestore returns a JSON stream (one JSON object per line), not a JSON array.
 */
export async function batchGetDocs(
  env: Env,
  paths: string[],
): Promise<Map<string, { id: string; data: Record<string, unknown> }>> {
  const result = new Map<string, { id: string; data: Record<string, unknown> }>();
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return result;

  const token = await getAccessToken(env);
  const endpoint = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:batchGet`;

  // Keep the request size bounded and avoid excessively large JSON payloads.
  for (let offset = 0; offset < uniquePaths.length; offset += 100) {
    const chunk = uniquePaths.slice(offset, offset + 100);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: chunk.map((path) => docPath(env, path)) }),
    });
    if (!resp.ok) {
      safeError("Firestore batchGet failed", { status: resp.status, count: chunk.length });
      throw new Error(`FIRESTORE_BATCH_GET_FAILED: ${resp.status}`);
    }

    const body = await resp.text();
    let entries: unknown[] = [];
    try {
      const parsed = JSON.parse(body) as unknown;
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      entries = body.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    }

    for (const entryValue of entries) {
      const entry = entryValue as {
        found?: { name?: string; fields?: Record<string, FirestoreValue> };
        missing?: string;
      };
      if (!entry?.found?.name) continue;
      const parsed = fromFirestoreDoc(entry.found);
      if (parsed) {
        const marker = "/documents/";
        const idx = entry.found.name.indexOf(marker);
        const path = idx >= 0 ? entry.found.name.slice(idx + marker.length) : "";
        if (path) result.set(path, parsed);
      }
    }
  }
  return result;
}

export async function commitWrites(
  env: Env,
  writes: Array<{
    path: string;
    data: Record<string, unknown>;
    updateMaskFields?: string[];
    exists?: boolean;
  }>,
): Promise<void> {
  if (writes.length === 0) return;
  const token = await getAccessToken(env);
  const endpoint = commitPath(env);

  // Firestore accepts up to 500 writes per commit. Use a lower chunk size to
  // leave room for payload size and future fields.
  for (let offset = 0; offset < writes.length; offset += 400) {
    const chunk = writes.slice(offset, offset + 400);
    const firestoreWrites = chunk.map((entry) => {
      const fields: Record<string, FirestoreValue> = {};
      for (const [key, value] of Object.entries(entry.data)) fields[key] = toFirestoreValue(value);
      const write: Record<string, unknown> = {
        update: { name: docPath(env, entry.path), fields },
      };
      if (entry.updateMaskFields) {
        write.updateMask = { fieldPaths: entry.updateMaskFields };
      }
      if (entry.exists !== undefined) {
        write.currentDocument = { exists: entry.exists };
      }
      return write;
    });

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: firestoreWrites }),
    });
    if (!resp.ok) {
      safeError("Firestore batch commit failed", { status: resp.status, count: chunk.length });
      throw new Error(`FIRESTORE_BATCH_COMMIT_FAILED: ${resp.status}`);
    }
  }
}

export async function setDoc(env: Env, path: string, data: Record<string, unknown>): Promise<void> {
  const token = await getAccessToken(env);
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFirestoreValue(v);
  const resp = await fetch(docPath(env, path) + "?currentDocument.exists=false", { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!resp.ok) { safeError("Firestore setDoc failed", { path, status: resp.status }); throw new Error(`FIRESTORE_SET_FAILED: ${resp.status}`); }
}

export async function updateDoc(env: Env, path: string, data: Record<string, unknown>): Promise<void> {
  const token = await getAccessToken(env);
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFirestoreValue(v);
  const url = new URL(docPath(env, path));
  // Firestore REST expects one updateMask.fieldPaths query parameter per field.
  // A comma-joined value is parsed as a single field path and can cause HTTP 400.
  for (const fieldPath of Object.keys(fields)) {
    url.searchParams.append("updateMask.fieldPaths", fieldPath);
  }
  const resp = await fetch(url.toString(), { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!resp.ok) { safeError("Firestore updateDoc failed", { path, status: resp.status }); throw new Error(`FIRESTORE_UPDATE_FAILED: ${resp.status}`); }
}

export async function createDoc(env: Env, collectionPath: string, data: Record<string, unknown>): Promise<string> {
  const token = await getAccessToken(env);
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) fields[k] = toFirestoreValue(v);
  const resp = await fetch(docPath(env, collectionPath), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!resp.ok) throw new Error(`FIRESTORE_CREATE_FAILED: ${resp.status}`);
  const doc = await resp.json() as { name: string };
  return doc.name.split("/").pop()!;
}

export async function queryCollection(env: Env, collectionPath: string, filters: Array<{ field: string; op: string; value: unknown }>, limit = 100): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const token = await getAccessToken(env);
  const toFilter = (f: { field: string; op: string; value: unknown }) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: toFirestoreValue(f.value) } });
  const compositeFilter = (fs: typeof filters) => ({ compositeFilter: { op: "AND", filters: fs.map(toFilter) } });
  const structuredQuery = { from: [{ collectionId: collectionPath.split("/").pop() }], where: filters.length === 1 ? toFilter(filters[0]) : compositeFilter(filters), limit };
  const resp = await fetch(runQueryPath(env), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery }) });
  if (!resp.ok) throw new Error(`FIRESTORE_QUERY_FAILED: ${resp.status}`);
  const results = await resp.json() as Array<{ document?: { name?: string; fields?: Record<string, FirestoreValue> } }>;
  const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const result of results) { if (result.document) { const parsed = fromFirestoreDoc(result.document); if (parsed) docs.push(parsed); } }
  return docs;
}

export async function beginTransaction(env: Env): Promise<string> {
  const token = await getAccessToken(env);
  const resp = await fetch(transactionPath(env), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ options: { readWrite: {} } }) });
  if (!resp.ok) throw new Error(`TXN_BEGIN_FAILED: ${resp.status}`);
  return (await resp.json() as { transaction: string }).transaction;
}

export async function commitTransaction(env: Env, transaction: string, writes: Array<{ update?: { name: string; fields: Record<string, FirestoreValue> }; currentDocument?: { exists: boolean } }>): Promise<void> {
  const token = await getAccessToken(env);
  const resp = await fetch(commitPath(env), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ writes, transaction }) });
  if (!resp.ok) { safeError("Firestore commit failed", { status: resp.status }); throw new Error(`TXN_COMMIT_FAILED: ${resp.status}`); }
}

export async function rollbackTransaction(env: Env, transaction: string): Promise<void> {
  const token = await getAccessToken(env);
  await fetch(`${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:rollback`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ transaction }) });
}
