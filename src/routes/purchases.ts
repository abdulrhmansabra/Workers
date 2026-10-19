import type { Env } from "../types";
import { json, HttpError, safeLog, safeError, parseJsonBody } from "../utils";
import { creditPurchase } from "../credits";
import { getDoc } from "../firestore";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

interface PurchaseRequestBody { product_id: string; purchase_token: string; order_id: string; }
const PRODUCT_CREDITS: Record<string, number> = { "credits_100": 100, "credits_500": 500, "credits_1000": 1000 };

export const purchaseHandler: RouteHandler = async (request, env: Env) => {
  if (env.GOOGLE_PLAY_BILLING_ENABLED !== "true") throw new HttpError(403, "BILLING_DISABLED", "Google Play Billing is not enabled");
  const auth = await requireAuth(request, env);
  const body = await parseJsonBody<PurchaseRequestBody>(request);
  if (!body.product_id || !body.purchase_token || !body.order_id) throw new HttpError(400, "MISSING_FIELDS", "product_id, purchase_token, and order_id are required");
  const existing = await getDoc(env, `purchase_events/${body.purchase_token}`);
  if (existing) { safeLog("Duplicate purchase token", { productId: body.product_id }); return json({ ok: true, data: { verified: true, credited: false, status: existing.data.status, credits: existing.data.balance_after } }); }
  const verification = await verifyGooglePlayPurchase(env, body.product_id, body.purchase_token);
  if (!verification.valid) throw new HttpError(400, "PURCHASE_INVALID", "Purchase could not be verified");
  if (verification.purchaseState === "cancelled" || verification.purchaseState === "refunded") { safeLog("Purchase cancelled/refunded", { productId: body.product_id }); return json({ ok: true, data: { verified: true, credited: false, status: verification.purchaseState } }); }
  const credits = PRODUCT_CREDITS[body.product_id];
  if (!credits) throw new HttpError(400, "UNKNOWN_PRODUCT", `Unknown product: ${body.product_id}`);
  try { const result = await creditPurchase(env, auth.uid, body.purchase_token, body.product_id, body.order_id, credits); return json({ ok: true, data: { verified: true, credited: result.credited, credits: result.balanceAfter } }); }
  catch { safeError("Purchase credit failed", { uid: auth.uid, productId: body.product_id }); throw new HttpError(500, "CREDIT_FAILED", "Failed to credit purchase"); }
};

interface PlayPurchaseVerification { valid: boolean; purchaseState: "purchased" | "cancelled" | "refunded" | "unknown"; }
async function verifyGooglePlayPurchase(env: Env, productId: string, purchaseToken: string): Promise<PlayPurchaseVerification> {
  safeLog("Google Play verification not yet implemented", { productId });
  return { valid: false, purchaseState: "unknown" };
}
