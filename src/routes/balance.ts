import type { Env } from "../types";
import { json, HttpError } from "../utils";
import { getDoc } from "../firestore";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

export const balanceHandler: RouteHandler = async (request, env: Env) => {
  const auth = await requireAuth(request, env);
  const userDoc = await getDoc(env, `users/${auth.uid}`);
  const credits = (userDoc?.data?.credits as number) ?? 0;
  return json({ ok: true, data: { uid: auth.uid, credits, updated_at: userDoc?.data?.updated_at ?? null } });
};
