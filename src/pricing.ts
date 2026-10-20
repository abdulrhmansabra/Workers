import type { Env, TemplateDoc } from "./types";
import { getDoc } from "./firestore";
import { HttpError } from "./utils";

const CATALOG_DOC = "crun_template_catalog/catalog_v1";
export interface PriceBreakdown { base: number; options: Record<string, number>; total: number; }

export function validateOptions(template: TemplateDoc, options: Record<string, unknown>): void {
  for (const opt of template.supported_options ?? []) {
    const value = options[opt.key];
    if (opt.required && (value === undefined || value === null)) throw new HttpError(400, "MISSING_OPTION", `Missing required option: ${opt.key}`);
    if (value === undefined || value === null) continue;
    switch (opt.type) {
      case "select":
        if (opt.allowed_values && !opt.allowed_values.includes(value as string | number)) throw new HttpError(400, "INVALID_OPTION_VALUE", `Option ${opt.key} has invalid value: ${String(value)}`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_OPTION_TYPE", `Option ${opt.key} must be a number`);
        if (opt.min !== undefined && value < opt.min) throw new HttpError(400, "OPTION_OUT_OF_RANGE", `Option ${opt.key} below minimum ${opt.min}`);
        if (opt.max !== undefined && value > opt.max) throw new HttpError(400, "OPTION_OUT_OF_RANGE", `Option ${opt.key} above maximum ${opt.max}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new HttpError(400, "INVALID_OPTION_TYPE", `Option ${opt.key} must be boolean`);
        break;
      case "text":
        if (typeof value !== "string") throw new HttpError(400, "INVALID_OPTION_TYPE", `Option ${opt.key} must be string`);
        break;
    }
  }
  const allowedKeys = new Set((template.supported_options ?? []).map((o) => o.key));
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) throw new HttpError(400, "UNKNOWN_OPTION", `Unknown option: ${key}`);
  }
}

export function calculatePrice(template: TemplateDoc, options: Record<string, unknown>): PriceBreakdown {
  const breakdown: PriceBreakdown = { base: template.base_cost, options: {}, total: template.base_cost };
  for (const opt of template.supported_options ?? []) {
    const value = options[opt.key];
    if (value === undefined || value === null) continue;
    if (template.option_pricing && template.option_pricing[opt.key]) {
      const priceTable = template.option_pricing[opt.key];
      const valueStr = String(value);
      if (valueStr in priceTable) {
        const optCost = priceTable[valueStr];
        breakdown.options[opt.key] = optCost;
        breakdown.total += optCost;
      }
    }
  }
  breakdown.total = Math.max(0, Math.round(breakdown.total));
  return breakdown;
}

export const ALLOWED_MODELS = new Set<string>([]);

export async function getValidTemplate(env: Env, templateId: string): Promise<TemplateDoc> {
  const catalog = await getDoc(env, CATALOG_DOC);
  const templates = catalog?.data.templates;
  const map = templates && typeof templates === "object" && !Array.isArray(templates)
    ? templates as Record<string, Record<string, unknown>>
    : {};
  const data = map[templateId];
  if (!data) throw new HttpError(404, "TEMPLATE_NOT_FOUND", `Template not found: ${templateId}`);
  const template = {
    ...data,
    id: templateId,
    crun_provider: data.provider,
    crun_template_id: data.provider_template_id,
    thumbnail_url: data.cover_url,
    preview_video_url: typeof data.preview_video_url === "string" ? data.preview_video_url : "",
    description: typeof data.description === "string" ? data.description : "",
    base_cost: typeof data.base_cost === "number" ? data.base_cost : 0,
    supported_options: Array.isArray(data.supported_options) ? data.supported_options : [],
    created_at: typeof data.created_at === "number" ? data.created_at : Date.now(),
    updated_at: typeof data.updated_at === "number" ? data.updated_at : Date.now(),
  } as unknown as TemplateDoc;
  if (template.is_active !== true) throw new HttpError(400, "TEMPLATE_INACTIVE", "This template is no longer available");
  if (!Number.isFinite(template.base_cost) || template.base_cost <= 0) {
    throw new HttpError(400, "TEMPLATE_PRICE_NOT_CONFIGURED", "Template must have a positive base_cost before it can be used");
  }
  if (!template.crun_provider || !template.crun_template_id ||
      !["kling", "bytedance", "vidu"].includes(template.crun_provider)) {
    throw new HttpError(400, "TEMPLATE_NOT_CONFIGURED", "Template provider settings are missing or invalid");
  }
  return template;
}

export function registerAllowedModel(modelId: string): void { ALLOWED_MODELS.add(modelId); }
