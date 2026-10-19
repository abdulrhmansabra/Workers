import type { Env } from "../types";
import { json, HttpError, parseJsonBody } from "../utils";
import { getValidTemplate, validateOptions, calculatePrice } from "../pricing";
import { getPricingVersion } from "../credits";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

interface QuoteRequestBody {
  template_id: string;
  options: Record<string, unknown>;
}

export const quoteHandler: RouteHandler = async (request, env: Env) => {
  const auth = await requireAuth(request, env);
  const body = await parseJsonBody<QuoteRequestBody>(request);
  if (!body.template_id) throw new HttpError(400, "MISSING_TEMPLATE", "template_id is required");
  const template = await getValidTemplate(env, body.template_id);
  validateOptions(template, body.options ?? {});
  const breakdown = calculatePrice(template, body.options ?? {});
  return json({ ok: true, data: { price: breakdown.total, breakdown: { base: breakdown.base, options: breakdown.options }, pricing_version: getPricingVersion() } });
};
