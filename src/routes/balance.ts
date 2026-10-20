import type { Env } from "../types";
import { json, HttpError } from "../utils";
import { getDoc, setDoc } from "../firestore";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

export const balanceHandler: RouteHandler = async (request, env: Env) => {
  const auth = await requireAuth(request, env);
  const userPath = `users/${auth.uid}`;
  let userDoc = await getDoc(env, userPath);

  if (!userDoc) {
    // Create a minimal account document on first authenticated access.
    // setDoc uses an exists=false precondition, so existing user data is never overwritten.
    try {
      await setDoc(env, userPath, {
        created_at: new Date(),
        credits: 0,
        is_active: true,
        reserved_credits: 0,
      });
    } catch (error) {
      // Another simultaneous request may have created the same user document.
      // Re-read it before treating the write as a real failure.
      userDoc = await getDoc(env, userPath);
      if (!userDoc) throw error;
    }

    if (!userDoc) userDoc = await getDoc(env, userPath);
    if (!userDoc) {
      throw new HttpError(500, "USER_INITIALIZATION_FAILED", "Unable to initialize user account");
    }
  }

  const credits = (userDoc.data.credits as number) ?? 0;
  return json({
    ok: true,
    data: {
      uid: auth.uid,
      credits,
      updated_at: userDoc.data.updated_at ?? null,
    },
  });
};
