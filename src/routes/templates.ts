import type { Env, TemplateDoc } from "../types";
import { json, HttpError } from "../utils";
import { getDoc, queryCollection } from "../firestore";
import { getValidTemplate } from "../pricing";
import type { RouteHandler } from "../router";

export const templatesListHandler: RouteHandler = async (_request, env: Env) => {
  const docs = await queryCollection(env, "crun_template_catalog", [{ field: "is_active", op: "==", value: true }], 100);
  const candidates = docs.map((d) => ({
    ...d.data,
    id: d.id,
    crun_provider: d.data.provider,
    crun_template_id: d.data.provider_template_id,
    thumbnail_url: d.data.cover_url,
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
