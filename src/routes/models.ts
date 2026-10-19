import type { Env } from "../types";
import { json } from "../utils";
import { queryCollection } from "../firestore";
import type { RouteHandler } from "../router";

export const modelsHandler: RouteHandler = async (_request, env: Env) => {
  const docs = await queryCollection(env, "models", [{ field: "is_active", op: "==", value: true }], 100);
  const models = docs.filter((doc) => String(doc.data.provider ?? "").toLowerCase() === "crun").map((doc) => ({ id: doc.id, ...doc.data }));
  return json({ ok: true, data: { models, count: models.length } });
};
