import type { Env } from "../types";
import { json, HttpError, safeLog, safeError } from "../utils";
import { verifyAdMobSSV, checkDailyLimit, DEFAULT_AD_REWARD_SETTINGS, SSVError } from "../admob";
import { creditAdReward } from "../credits";
import { getDoc } from "../firestore";
import type { RouteHandler } from "../router";

export const admobSSVHandler: RouteHandler = async (request, env: Env) => {
  if (env.ADMOB_SSV_ENABLED !== "true") throw new HttpError(403, "SSV_DISABLED", "AdMob SSV is not enabled");
  const url = new URL(request.url);
  let verified;
  try { verified = await verifyAdMobSSV(url, env); }
  catch (err) { if (err instanceof SSVError) { safeError("AdMob SSV verification failed", { code: err.code }); throw new HttpError(403, err.code, err.message); } throw new HttpError(500, "SSV_ERROR", "SSV verification error"); }
  const { userId, transactionId, adUnit } = verified;
  const settings = await getRewardSettings(env);
  const withinLimits = await checkDailyLimit(env, userId, settings);
  if (!withinLimits) { safeLog("Ad reward blocked: daily limit", { userId }); return json({ ok: true, data: { verified: true, credited: false, reason: "daily_limit" } }); }
  try { const result = await creditAdReward(env, userId, transactionId, settings.reward_amount, adUnit); return json({ ok: true, data: { verified: true, credited: result.credited, credits: result.balanceAfter } }); }
  catch { safeError("Ad reward credit failed", { userId, transactionId }); throw new HttpError(500, "CREDIT_FAILED", "Failed to credit reward"); }
};

async function getRewardSettings(env: Env) {
  const doc = await getDoc(env, "app_config/general");
  if (doc?.data) return { reward_amount: (doc.data.reward_amount as number) ?? DEFAULT_AD_REWARD_SETTINGS.reward_amount, daily_limit: (doc.data.daily_limit as number) ?? DEFAULT_AD_REWARD_SETTINGS.daily_limit, daily_credit_cap: (doc.data.daily_credit_cap as number) ?? DEFAULT_AD_REWARD_SETTINGS.daily_credit_cap };
  return DEFAULT_AD_REWARD_SETTINGS;
}
