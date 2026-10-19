import type { Env, TemplateDoc } from "../types";
import { json, HttpError } from "../utils";
import { getDoc, queryCollection } from "../firestore";

import type { RouteHandler } from "../router";

export const templatesListHandler: RouteHandler = async (request, env: Env) => {
  const docs = await queryCollection(env, "templates", [{ field: "is_active", op: "==", value: true }], 100);
  const candidates = docs.map((d) => ({ ...d.data, id: d.id }) as unknown as TemplateDoc);
  const activeChecks = await Promise.all(candidates.map(async (template) => {
    const model = await getDoc(env, `models/${template.model_id}`);
    return model?.data.is_active === true && String(model.data.provider ?? "").toLowerCase() === "crun" && typeof model.data.provider_model_id === "string" && !!model.data.provider_model_id.trim() ? template : null;
  }));
  const templates = activeChecks.filter((t): t is TemplateDoc => t !== null);
  return json({ ok: true, data: { templates, count: templates.length } });
};

export const templateDetailHandler: RouteHandler = async (request, env: Env, ctx, params) => {
  const templateId = params.templateId;
  if (!templateId) throw new HttpError(400, "MISSING_PARAM", "templateId is required");
  const doc = await getDoc(env, `templates/${templateId}`);
  if (!doc) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "Template not found");
  const template = doc.data as unknown as TemplateDoc;
  template.id = doc.id;
  if (!template.is_active) throw new HttpError(400, "TEMPLATE_INACTIVE", "Template is not active");
  const model = await getDoc(env, `models/${template.model_id}`);
  if (!model || model.data.is_active !== true || String(model.data.provider ?? "").toLowerCase() !== "crun" || typeof model.data.provider_model_id !== "string" || !model.data.provider_model_id.trim()) throw new HttpError(400, "MODEL_NOT_ALLOWED", "Template model is not an active, configured Crun.ai model");
  return json({ ok: true, data: template });
};
