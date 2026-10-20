import type { Env, CrunTemplateSyncMessage } from "./types";
import { batchGetDocs, commitWrites } from "./firestore";
import { safeError, safeLog } from "./utils";

export type CatalogProvider = "kling" | "bytedance" | "vidu";
type RecordValue = Record<string, unknown>;

const SOURCES: Array<{ provider: CatalogProvider; path: string }> = [
  { provider: "kling", path: "/api/v1/client/job/kling-templates" },
  { provider: "bytedance", path: "/api/v1/client/job/bytedance-templates" },
  { provider: "vidu", path: "/api/v1/client/job/vidu-templates" },
];
const PAGE_SIZE = 50;
const MAX_DISCOVERED_PAGES = 10000;

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function catalogItems(data: RecordValue): unknown[] {
  const candidates: RecordValue[] = [data];
  for (const key of ["data", "result", "catalog", "response"]) {
    const nested = data[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) candidates.push(nested as RecordValue);
  }
  for (const candidate of candidates) {
    for (const key of ["templates", "items", "list", "records"]) {
      if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
    }
    for (const key of ["data", "result"]) {
      if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
    }
  }
  const total = candidates.map((candidate) => candidate.total).find((value) => typeof value === "number" || typeof value === "string");
  if (Number(total) === 0) return [];
  const keys = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate)))].slice(0, 20);
  throw new Error("CRUN_CATALOG_UNRECOGNIZED_RESPONSE: " + keys.join(","));
}
function totalCount(data: RecordValue): number | null {
  const candidates: RecordValue[] = [data];
  for (const key of ["data", "result", "catalog", "response"]) {
    const nested = data[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) candidates.push(nested as RecordValue);
  }
  for (const candidate of candidates) {
    const value = candidate.total ?? candidate.total_count ?? candidate.totalCount;
    if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}
function identity(provider: CatalogProvider, item: RecordValue): { key: string; name: string; cover: string; preview: string; providerId: string } | null {
  const providerId = provider === "kling" ? string(item.key)
    : provider === "bytedance" ? string(item.TemplateId ?? item.template_id ?? item.id)
    : string(item.template ?? item.template_id ?? item.key ?? item.id);
  if (!providerId) return null;
  const name = provider === "kling" ? string(item.name) || providerId
    : provider === "bytedance" ? string(item.Title_en ?? item.Title ?? item.name) || providerId
    : string(item.name ?? item.title ?? item.template_name) || providerId;
  return {
    key: providerId,
    providerId,
    name,
    cover: string(item.cover_url ?? item.Cover ?? item.cover ?? item.coverUrl),
    preview: string(item.video_url ?? item.PreviewVideo ?? item.preview_video_url ?? item.previewVideo ?? item.video),
  };
}
function sourceFor(provider: CatalogProvider) {
  const source = SOURCES.find((item) => item.provider === provider);
  if (!source) throw new Error("CRUN_PROVIDER_UNSUPPORTED");
  return source;
}
async function requestCatalog(env: Env, path: string, page: number): Promise<RecordValue> {
  if (!env.CRUN_API_KEY) throw new Error("CRUN_API_KEY is not configured");
  const base = (env.CRUN_BASE_URL || "https://api.crun.ai").replace(/\/+$/, "");
  const separator = path.includes("?") ? "&" : "?";
  const language = path.includes("kling-templates") ? "&language=en" : "";
  const response = await fetch(base + path + separator + "page=" + page + "&page_size=" + PAGE_SIZE + language, {
    headers: { "X-API-KEY": env.CRUN_API_KEY, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("CRUN_CATALOG_HTTP_" + response.status);
  const payload = object(await response.json());
  if (typeof payload.code === "number" && payload.code !== 200) throw new Error("CRUN_CATALOG_API_ERROR");
  return object(payload.data);
}

/** Discover every provider's page count, then enqueue one independent task per page. */
export async function enqueueCrunTemplateSync(env: Env): Promise<{ providers: number; pages: number }> {
  if (!env.CRUN_TEMPLATE_QUEUE) throw new Error("CRUN_TEMPLATE_QUEUE binding is not configured");
  let pagesQueued = 0;
  const messages: CrunTemplateSyncMessage[] = [];

  for (const source of SOURCES) {
    const firstPage = await requestCatalog(env, source.path, 1);
    const items = catalogItems(firstPage);
    const total = totalCount(firstPage);
    if (total === null && items.length >= PAGE_SIZE) {
      throw new Error("CRUN_CATALOG_TOTAL_MISSING: " + source.provider);
    }
    const pageCount = Math.max(1, Math.ceil((total ?? items.length) / PAGE_SIZE));
    if (pageCount > MAX_DISCOVERED_PAGES) throw new Error("CRUN_CATALOG_PAGE_COUNT_INVALID");
    for (let page = 1; page <= pageCount; page++) messages.push({ provider: source.provider, page });
  }

  // Keep the producer below the Workers subrequest budget even for unusually large catalogs.
  // A maximum of 4,000 messages means at most 40 sendBatch calls, plus three CRUN discovery calls.
  if (messages.length > 4000) throw new Error("CRUN_CATALOG_QUEUE_BATCH_LIMIT_EXCEEDED");

  // Queue sendBatch accepts at most 100 messages per call. Keep each send bounded.
  for (let offset = 0; offset < messages.length; offset += 100) {
    const chunk = messages.slice(offset, offset + 100);
    await env.CRUN_TEMPLATE_QUEUE.sendBatch(chunk.map((body) => ({ body })));
    pagesQueued += chunk.length;
  }
  safeLog("CRUN catalog sync tasks queued", { providers: SOURCES.length, pages: pagesQueued });
  return { providers: SOURCES.length, pages: pagesQueued };
}

/** Processes exactly one provider page, so each Queue invocation has a bounded subrequest count. */
export async function syncCrunTemplatePage(env: Env, provider: CatalogProvider, page: number): Promise<number> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_DISCOVERED_PAGES) throw new Error("CRUN_CATALOG_PAGE_INVALID");
  const source = sourceFor(provider);
  const data = await requestCatalog(env, source.path, page);
  const items = catalogItems(data);
  const pending: Array<{
    docId: string;
    info: { key: string; name: string; cover: string; preview: string; providerId: string };
    record: RecordValue;
  }> = [];

  for (const raw of items) {
    const item = object(raw);
    const info = identity(provider, item);
    if (!info) continue;
    const docId = (provider + "_" + info.key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
    const consumeItems = Array.isArray(item.ConsumeItems) ? item.ConsumeItems : [];
    const record = {
      id: docId,
      provider,
      provider_template_id: info.providerId,
      name: info.name,
      category: string(item.category ?? item.category_name ?? item.Category ?? item.TemplateType),
      cover_url: info.cover,
      preview_video_url: info.preview,
      provider_cost: Number(item.credit ?? item.credits ?? item.Credit ?? object(consumeItems[0]).Credit) || 0,
      raw_catalog: JSON.stringify(item),
      last_synced_at: Date.now(),
    };
    pending.push({ docId, info, record });
  }

  if (pending.length === 0) {
    safeLog("CRUN catalog page synced", { provider, page, count: 0 });
    return 0;
  }

  const paths = pending.flatMap(({ docId }) => [
    "crun_template_catalog/" + docId,
    "templates/" + docId,
  ]);
  const existingDocs = await batchGetDocs(env, paths);
  const writes: Array<{
    path: string;
    data: RecordValue;
    updateMaskFields?: string[];
    exists?: boolean;
  }> = [];

  for (const { docId, info, record } of pending) {
    const catalogPath = "crun_template_catalog/" + docId;
    const templatePath = "templates/" + docId;
    writes.push({ path: catalogPath, data: record, updateMaskFields: Object.keys(record) });

    // Keep administrator-owned template configuration untouched.
    if (existingDocs.has(templatePath)) {
      writes.push({
        path: templatePath,
        data: { provider_cost: record.provider_cost },
        updateMaskFields: ["provider_cost"],
      });
    } else {
      const now = Date.now();
      writes.push({
        path: templatePath,
        exists: false,
        data: {
          id: docId,
          name: info.name,
          description: "",
          category: "video",
          crun_provider: provider,
          crun_template_id: info.providerId,
          is_active: false,
          base_cost: 0,
          provider_cost: record.provider_cost,
          preview_video_url: info.preview,
          thumbnail_url: info.cover,
          reference_video_url: "",
          customization_config: {
            allow_image_input: false,
            allow_prompt: true,
            allow_reference_video: false,
          },
          aspect_ratio_options: [],
          duration_options: [],
          resolution_options: [],
          option_pricing: {},
          supported_options: [],
          pricing_version: 1,
          sort_order: 999,
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  await commitWrites(env, writes);
  safeLog("CRUN catalog page synced", { provider, page, count: pending.length, firestoreWrites: writes.length });
  return pending.length;
}
