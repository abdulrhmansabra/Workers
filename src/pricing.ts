import type { Env, TemplateDoc } from "./types";
import { getDoc } from "./firestore";
import { HttpError } from "./utils";

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
  const doc = await getDoc(env, `templates/${templateId}`);
  if (!doc) throw new HttpError(404, "TEMPLATE_NOT_FOUND", `Template not found: ${templateId}`);
  const template = doc.data as unknown as TemplateDoc;
  template.id = doc.id;
  if (!template.active) throw new HttpError(400, "TEMPLATE_INACTIVE", "This template is no longer available");
  if (!ALLOWED_MODELS.has(template.model_id)) throw new HttpError(400, "MODEL_NOT_ALLOWED", `Template references an unapproved model: ${template.model_id}`);
  return template;
}

export function registerAllowedModel(modelId: string): void { ALLOWED_MODELS.add(modelId); }
