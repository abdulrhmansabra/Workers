import type { Env } from "../types";
import { json, HttpError, safeLog, rateLimit } from "../utils";
import { validateFileMetadata, uploadToR2, generateObjectKey, generateProtectedPath, getFromR2 } from "../r2";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

export const uploadHandler: RouteHandler = async (request, env: Env) => {
  const auth = await requireAuth(request, env);
  if (!rateLimit(`upload:${auth.uid}`, 20, 60_000)) throw new HttpError(429, "RATE_LIMITED", "Too many uploads");
  const contentType = request.headers.get("Content-Type") ?? "";
  const contentLength = parseInt(request.headers.get("Content-Length") ?? "0", 10);
  const maxMb = parseInt(env.MAX_UPLOAD_SIZE_MB ?? "50", 10);
  validateFileMetadata(contentType, contentLength, maxMb);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxMb * 1024 * 1024) throw new HttpError(413, "FILE_TOO_LARGE", `File exceeds ${maxMb}MB`);
  const key = generateObjectKey(auth.uid, contentType);
  await uploadToR2(env, auth.uid, body, contentType, key);
  safeLog("File uploaded", { uid: auth.uid, key, size: body.byteLength });
  return json({ ok: true, data: { key, upload_url: generateProtectedPath(key), expires_at: Date.now() + 24 * 60 * 60 * 1000 } }, 201);
};

export const fileAccessHandler: RouteHandler = async (request, env: Env, ctx, params) => {
  const auth = await requireAuth(request, env);
  const key = params.key ? decodeURIComponent(params.key) : "";
  if (!key) throw new HttpError(400, "MISSING_KEY", "File key is required");
  const obj = await getFromR2(env, key, auth.uid);
  if (!obj) throw new HttpError(404, "NOT_FOUND", "File not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("Content-Disposition", "inline");
  return new Response(obj.body, { headers });
};
