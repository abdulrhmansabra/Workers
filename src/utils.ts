import type { ApiResponse } from "./types";

export function uuid(): string {
  return crypto.randomUUID();
}

export function json<T>(body: ApiResponse<T> | Record<string, unknown>, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Idempotency-Key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function errorResponse(code: string, message: string, status = 400, origin = "*"): Response {
  return json({ ok: false, error: { code, message } }, status, origin);
}

export function corsResponse(origin = "*"): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Idempotency-Key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function safeLog(message: string, meta?: Record<string, unknown>): void {
  const redacted = meta ? JSON.stringify(meta, (key, value) => {
    if (typeof key === "string" && /key|token|secret|password|credential|auth/i.test(key) && typeof value === "string") return "[REDACTED]";
    return value;
  }) : "";
  console.log(`[ai-shorts] ${message}${redacted ? " " + redacted : ""}`);
}

export function safeError(message: string, meta?: Record<string, unknown>): void {
  const redacted = meta ? JSON.stringify(meta, (key, value) => {
    if (typeof key === "string" && /key|token|secret|password|credential|auth/i.test(key) && typeof value === "string") return "[REDACTED]";
    return value;
  }) : "";
  console.error(`[ai-shorts] ERROR: ${message}${redacted ? " " + redacted : ""}`);
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function parseJsonBody<T = Record<string, unknown>>(request: Request, maxBytes = 256 * 1024): Promise<T> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  const text = await request.text();
  if (text.length === 0) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new HttpError(400, "INVALID_JSON", "Invalid JSON body"); }
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(identifier: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);
  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(identifier, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && v > 0 && Number.isFinite(v);
}

export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
