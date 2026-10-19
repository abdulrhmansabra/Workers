import type { Env, TemplateDoc } from "../types";
import { json, HttpError } from "../utils";
import { getDoc, queryCollection } from "../firestore";
import { ALLOWED_MODELS } from "../pricing";
import type { RouteHandler } from "../router";

export const templatesListHandler: RouteHandler = async (request, env: Env) => {
  const docs = await queryCollection(env, "templates", [{ field: "is_active", op: "==", value: true }], 100);
  const templates = docs.map((d) => d.data as unknown as TemplateDoc).filter((t) => ALLOWED_MODELS.has(t.model_id));
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
  if (!ALLOWED_MODELS.has(template.model_id)) throw new HttpError(400, "MODEL_NOT_ALLOWED", "Template model is not approved");
  return json({ ok: true, data: template });
};
