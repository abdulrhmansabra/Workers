import type { Env } from "../types";
import { json } from "../utils";
import type { RouteHandler } from "../router";

export const healthHandler: RouteHandler = async (request, env: Env) => {
  return json({ ok: true, data: { status: "healthy", timestamp: Date.now(), environment: env.ENVIRONMENT, version: "1.0.0" } });
};
