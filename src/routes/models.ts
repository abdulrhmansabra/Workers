import type { Env } from "../types";
import { json } from "../utils";
import { listModels } from "../crun";
import type { RouteHandler } from "../router";

export const modelsHandler: RouteHandler = async (request, env: Env) => {
  const models = listModels();
  return json({ ok: true, data: { models, count: models.length } });
};
