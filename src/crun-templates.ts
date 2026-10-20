import type { Env, CrunTemplateSyncMessage } from "./types";
import { batchGetDocs, commitWrites, getDoc } from "./firestore";
import { safeLog } from "./utils";

export type CatalogProvider = "kling" | "bytedance" | "vidu";
type RecordValue = Record<string, unknown>;
const CATALOG_DOC = "crun_template_catalog/catalog_v1";

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
    key: providerId, providerId, name,
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

/** Discover page counts and enqueue bounded page jobs. */
export async function enqueueCrunTemplateSync(env: Env): Promise<{ providers: number; pages: number }> {
  if (!env.CRUN_TEMPLATE_QUEUE) throw new Error("CRUN_TEMPLATE_QUEUE binding is not configured");
  let pagesQueued = 0;
  const messages: CrunTemplateSyncMessage[] = [];
  for (const source of SOURCES) {
    const firstPage = await requestCatalog(env, source.path, 1);
    const items = catalogItems(firstPage);
    const total = totalCount(firstPage);
    if (total === null && items.length >= PAGE_SIZE) throw new Error("CRUN_CATALOG_TOTAL_MISSING: " + source.provider);
    const pageCount = Math.max(1, Math.ceil((total ?? items.length) / PAGE_SIZE));
    if (pageCount > MAX_DISCOVERED_PAGES) throw new Error("CRUN_CATALOG_PAGE_COUNT_INVALID");
    for (let page = 1; page <= pageCount; page++) messages.push({ provider: source.provider, page });
  }
  if (messages.length > 4000) throw new Error("CRUN_CATALOG_QUEUE_BATCH_LIMIT_EXCEEDED");
  for (let offset = 0; offset < messages.length; offset += 100) {
    const chunk = messages.slice(offset, offset + 100);
    await env.CRUN_TEMPLATE_QUEUE.sendBatch(chunk.map((body) => ({ body })));
    pagesQueued += chunk.length;
  }
  safeLog("CRUN catalog sync tasks queued", { providers: SOURCES.length, pages: pagesQueued });
  return { providers: SOURCES.length, pages: pagesQueued };
}

/** Writes each template into its own map entry in catalog_v1, without replacing other entries. */
export async function syncCrunTemplatePage(env: Env, provider: CatalogProvider, page: number): Promise<number> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_DISCOVERED_PAGES) throw new Error("CRUN_CATALOG_PAGE_INVALID");
  const source = sourceFor(provider);
  const data = await requestCatalog(env, source.path, page);
  const items = catalogItems(data);
  const pending: Array<{ docId: string; record: RecordValue }> = [];

  for (const raw of items) {
    const item = object(raw);
    const info = identity(provider, item);
    if (!info) continue;
    const docId = (provider + "_" + info.key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
    const consumeItems = Array.isArray(item.ConsumeItems) ? item.ConsumeItems : [];
    const asOptions = (value: unknown): unknown[] => Array.isArray(value) ? value : typeof value === "string" && value.trim() ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
    const aspectOptions = asOptions(item.aspect_ratio ?? item.SupportAspectRatio);
    const durationOptions = asOptions(item.duration);
    const consumeResolutions = consumeItems.map((entry) => object(entry).Resolution).filter((value) => value !== undefined && value !== null);
    const resolutionOptions = [...asOptions(item.resolution), ...consumeResolutions].filter((value, index, all) => all.indexOf(value) === index);
    const rawCatalog = item.raw_catalog ?? item;
    const rawMap = rawCatalog && typeof rawCatalog === "object" && !Array.isArray(rawCatalog)
      ? rawCatalog as RecordValue
      : { original_value: rawCatalog };
    const now = Date.now();
    const record: RecordValue = {
      id: docId,
      name: info.name,
      description: string(item.description ?? item.info_text),
      category: string(item.category ?? item.category_name ?? item.Category ?? item.TemplateType),
      provider,
      provider_template_id: info.providerId,
      provider_cost: Number(item.credit ?? item.credits ?? item.Credit ?? object(consumeItems[0]).Credit) || 0,
      base_cost: 0,
      cover_url: info.cover,
      preview_video_url: info.preview,
      is_active: false,
      customization_config: { allow_image_input: false, allow_prompt: false, allow_reference_video: false },
      aspect_ratio_options: aspectOptions,
      duration_options: durationOptions,
      resolution_options: resolutionOptions,
      option_pricing: {},
      supported_options: [],
      pricing_version: 1,
      sort_order: 0,
      raw_catalog: rawMap,
      created_at: null,
      updated_at: null,
      last_synced_at: now,
    };
    pending.push({ docId, record });
  }

  if (pending.length === 0) {
    safeLog("CRUN catalog page synced", { provider, page, count: 0 });
    return 0;
  }

  const unified = await getDoc(env, CATALOG_DOC);
  const templates = object(unified?.data.templates);
  const writes: Array<{ path: string; data: RecordValue; updateMaskFields: string[] }> = [];
  const providerFields = [
    "id", "name", "description", "category", "provider", "provider_template_id",
    "provider_cost", "cover_url", "preview_video_url", "raw_catalog", "last_synced_at",
  ];

  for (const { docId, record } of pending) {
    const current = object(templates[docId]);
    const isExisting = Object.keys(current).length > 0;
    const patch: RecordValue = {};
    const mask = ["updated_at"];
    if (isExisting) {
      for (const key of providerFields) patch[key] = record[key];
      mask.splice(0, 1, ...providerFields.map((key) => `templates.${docId}.${key}`), "updated_at");
    } else {
      Object.assign(patch, record);
      mask.splice(0, 1, `templates.${docId}`, "updated_at");
    }
    writes.push({
      path: CATALOG_DOC,
      data: { catalog_version: 1, updated_at: Date.now(), templates: { [docId]: patch } },
      updateMaskFields: mask,
    });
  }

  await commitWrites(env, writes);
  safeLog("CRUN catalog page synced into unified document", { provider, page, count: pending.length, firestoreWrites: writes.length });
  return pending.length;
}
