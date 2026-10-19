import type { Env } from "./types";
import { getDoc, setDoc, updateDoc } from "./firestore";
import { safeError, safeLog } from "./utils";

type CatalogProvider = "kling" | "bytedance" | "vidu";
type RecordValue = Record<string, unknown>;

const SOURCES: Array<{ provider: CatalogProvider; path: string }> = [
  { provider: "kling", path: "/api/v1/client/job/kling-templates" },
  { provider: "bytedance", path: "/api/v1/client/job/bytedance-templates" },
  { provider: "vidu", path: "/api/v1/client/job/vidu-templates" },
];

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function catalogItems(data: RecordValue): unknown[] {
  for (const key of ["templates", "items", "list", "records"]) {
    if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  return [];
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
async function requestCatalog(env: Env, path: string, page: number): Promise<RecordValue> {
  if (!env.CRUN_API_KEY) throw new Error("CRUN_API_KEY is not configured");
  const base = (env.CRUN_BASE_URL || "https://api.crun.ai").replace(/\/+$/, "");
  const separator = path.includes("?") ? "&" : "?";
  const language = path.includes("kling-templates") ? "&language=en" : "";
  const response = await fetch(base + path + separator + "page=" + page + "&page_size=50" + language, {
    headers: { "X-API-KEY": env.CRUN_API_KEY, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("CRUN_CATALOG_HTTP_" + response.status);
  const payload = object(await response.json());
  if (typeof payload.code === "number" && payload.code !== 200) throw new Error("CRUN_CATALOG_API_ERROR");
  return object(payload.data);
}

/**
 * Refreshes a provider-owned catalog in its own collection. It never writes to
 * the templates collection, so administrator activation and pricing stay intact.
 */
export async function syncCrunTemplateCatalog(env: Env): Promise<{ providers: number; templates: number }> {
  let total = 0;
  let successfulProviders = 0;
  for (const source of SOURCES) {
    try {
      let providerCount = 0;
      for (let page = 1; page <= 20; page++) {
        const data = await requestCatalog(env, source.path, page);
        const items = catalogItems(data);
        if (items.length === 0) break;
        for (const raw of items) {
          const item = object(raw);
          const info = identity(source.provider, item);
          if (!info) continue;
          const docId = (source.provider + "_" + info.key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
          const path = "crun_template_catalog/" + docId;
          const existing = await getDoc(env, path);
          const record = {
            id: docId,
            provider: source.provider,
            provider_template_id: info.providerId,
            name: info.name,
            category: string(item.category ?? item.category_name ?? item.Category ?? item.TemplateType),
            cover_url: info.cover,
            preview_video_url: info.preview,
            provider_cost: Number(item.credit ?? item.credits ?? item.Credit ?? (Array.isArray(item.ConsumeItems) ? object(item.ConsumeItems[0]).Credit : 0)) || 0,
            raw_catalog: item,
            last_synced_at: Date.now(),
          };
          if (existing) await updateDoc(env, path, record);
          else await setDoc(env, path, record);
          providerCount++;
        }
        const totalAvailable = Number(data.total);
        if (!Number.isFinite(totalAvailable) || page * 50 >= totalAvailable || items.length < 50) break;
      }
      successfulProviders++;
      total += providerCount;
      safeLog("Crun template catalog synced", { provider: source.provider, count: providerCount });
    } catch (error) {
      safeError("Crun template catalog sync failed", {
        provider: source.provider,
        error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
    }
  }
  if (successfulProviders === 0) throw new Error("CRUN_TEMPLATE_CATALOG_SYNC_FAILED");
  return { providers: successfulProviders, templates: total };
}
