import type { Env, TemplateDoc } from "../types";
import { json, HttpError } from "../utils";
import { getDoc } from "../firestore";
import { getValidTemplate } from "../pricing";
import type { RouteHandler } from "../router";

const CATALOG_DOC = "crun_template_catalog/catalog_v1";

export const templatesListHandler: RouteHandler = async (_request, env: Env) => {
  const catalog = await getDoc(env, CATALOG_DOC);
  const templateMap = catalog?.data.templates;
  const entries = templateMap && typeof templateMap === "object" && !Array.isArray(templateMap)
    ? Object.entries(templateMap as Record<string, Record<string, unknown>>)
    : [];
  const candidates = entries
    .filter(([, data]) => data && data.is_active === true)
    .map(([id, data]) => ({
      ...data,
      id,
      crun_provider: data.provider,
      crun_template_id: data.provider_template_id,
      thumbnail_url: data.cover_url,
    }) as unknown as TemplateDoc);
  const activeChecks = await Promise.all(candidates.map(async (template) => {
    try { return await getValidTemplate(env, template.id); }
    catch { return null; }
  }));
  const templates = activeChecks.filter((t): t is TemplateDoc => t !== null);
  return json({ ok: true, data: { templates, count: templates.length } });
};

export const templateDetailHandler: RouteHandler = async (_request, env: Env, _ctx, params) => {
  const templateId = params.templateId;
  if (!templateId) throw new HttpError(400, "MISSING_PARAM", "templateId is required");
  const template = await getValidTemplate(env, templateId);
  return json({ ok: true, data: template });
};
