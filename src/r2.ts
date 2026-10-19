import type { Env } from "./types";
import { HttpError, uuid } from "./utils";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4"]);
const MAX_UPLOAD_SIZE_MB = 50;

export function generateObjectKey(uid: string, mimeType: string): string {
  const ext = mimeTypeToExt(mimeType);
  return `uploads/${uid}/${uuid()}.${ext}`;
}

export function generateOutputKey(uid: string, jobId: string, ext: string): string {
  return `outputs/${uid}/${jobId}.${ext}`;
}

function mimeTypeToExt(mime: string): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "video/mp4": return "mp4";
    default: return "bin";
  }
}

export function validateFileMetadata(mimeType: string, sizeBytes: number, maxMb = MAX_UPLOAD_SIZE_MB): void {
  if (!ALLOWED_MIME.has(mimeType)) throw new HttpError(400, "INVALID_MIME_TYPE", `Unsupported file type: ${mimeType}`);
  if (sizeBytes <= 0) throw new HttpError(400, "INVALID_SIZE", "File size must be positive");
  if (sizeBytes > maxMb * 1024 * 1024) throw new HttpError(413, "FILE_TOO_LARGE", `File exceeds maximum size of ${maxMb}MB`);
}

export async function uploadToR2(env: Env, uid: string, data: ArrayBuffer | ReadableStream, mimeType: string, key?: string): Promise<string> {
  const objectKey = key ?? generateObjectKey(uid, mimeType);
  await env.R2_BUCKET.put(objectKey, data, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { owner_uid: uid, uploaded_at: new Date().toISOString() },
  });
  return objectKey;
}

export async function getFromR2(env: Env, key: string, uid: string): Promise<R2ObjectBody | null> {
  if (!key.includes(`/${uid}/`)) throw new HttpError(403, "ACCESS_DENIED", "You do not own this file");
  return env.R2_BUCKET.get(key);
}

export function generateProtectedPath(key: string): string {
  return `/v1/files/${encodeURIComponent(key)}`;
}

export async function deleteFromR2(env: Env, key: string): Promise<void> {
  await env.R2_BUCKET.delete(key);
}

export async function cleanupOldUploads(env: Env, uid: string, olderThanMs: number): Promise<number> {
  const list = await env.R2_BUCKET.list({ prefix: `uploads/${uid}/` });
  const cutoff = Date.now() - olderThanMs;
  let deleted = 0;
  for (const item of list.objects) {
    if (item.uploaded.getTime() < cutoff) { await env.R2_BUCKET.delete(item.key); deleted++; }
  }
  return deleted;
}
