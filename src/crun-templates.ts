import type { Env } from "./types";
import { batchGetDocs, commitWrites } from "./firestore";
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
  // CRUN providers may wrap their catalog differently. ByteDance's documented
  // response is { code: 200, data: { total, templates: [...] } }.
  const candidates: RecordValue[] = [data];
  for (const key of ["data", "result", "catalog", "response"]) {
    const nested = data[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push(nested as RecordValue);
    }
  }
  for (const candidate of candidates) {
    for (const key of ["templates", "items", "list", "records"]) {
      if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
    }
    // Some APIs return the list itself as data.
    for (const key of ["data", "result"]) {
      if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
    }
  }
  const total = candidates.map((candidate) => candidate.total).find((value) => typeof value === "number");
  if (total === 0) return [];
  const keys = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate)))].slice(0, 20);
  throw new Error("CRUN_CATALOG_UNRECOGNIZED_RESPONSE: " + keys.join(","));
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
 * Refreshes the provider catalog and creates inactive draft documents for new
 * templates. Existing template configuration is administrator-owned; sync only
 * refreshes provider_cost on an existing matching template.
 */
export async function syncCrunTemplateCatalog(env: Env): Promise<{ providers: number; templates: number }> {
  let total = 0;
  let successfulProviders = 0;

  // The scheduled trigger runs daily at 03:00 UTC. Rotate providers by UTC weekday
  // so one invocation handles only one provider and stays within the Workers subrequest budget.
  const source = SOURCES[new Date().getUTCDay() % SOURCES.length];
  {

    try {
      // Fetch the provider catalog first, then read and write Firestore in batches.
      // This avoids a Firestore network request for every individual document.
      const pending: Array<{
        docId: string;
        info: { key: string; name: string; cover: string; preview: string; providerId: string };
        record: RecordValue;
      }> = [];

      for (let page = 1; page <= 5; page++) {
        const data = await requestCatalog(env, source.path, page);
        const items = catalogItems(data);
        if (items.length === 0) break;

        for (const raw of items) {
          const item = object(raw);
          const info = identity(source.provider, item);
          if (!info) continue;
          const docId = (source.provider + "_" + info.key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
          const record = {
            id: docId,
            provider: source.provider,
            provider_template_id: info.providerId,
            name: info.name,
            category: string(item.category ?? item.category_name ?? item.Category ?? item.TemplateType),
            cover_url: info.cover,
            preview_video_url: info.preview,
            provider_cost: Number(item.credit ?? item.credits ?? item.Credit ?? (Array.isArray(item.ConsumeItems) ? object(item.ConsumeItems[0]).Credit : 0)) || 0,
            raw_catalog: JSON.stringify(item),
            last_synced_at: Date.now(),
          };
          pending.push({ docId, info, record });
        }

        const totalAvailable = Number(data.total);
        if (!Number.isFinite(totalAvailable) || page * 50 >= totalAvailable || items.length < 50) break;
      }

      if (pending.length === 0) {
        successfulProviders++;
        safeLog("Crun template catalog synced", { provider: source.provider, count: 0 });
        continue;
      }

      // Batch reads are chunked to keep each request bounded.
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

        // Catalog fields are an upsert: update only synchronized fields so any
        // unrelated fields already present remain untouched.
        writes.push({
          path: catalogPath,
          data: record,
          updateMaskFields: Object.keys(record),
        });

        // Template pricing/configuration is admin-owned. Existing templates get
        // only provider_cost refreshed; missing templates get an inactive draft.
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
              crun_provider: source.provider,
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
      successfulProviders++;
      total += pending.length;
      safeLog("Crun template catalog synced", {
        provider: source.provider,
        count: pending.length,
        firestoreWrites: writes.length,
      });
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
