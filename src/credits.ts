import type { Env } from "./types";
import { getDoc, beginTransaction, commitTransaction, rollbackTransaction, toFirestoreValue, setDoc } from "./firestore";
import { safeError, safeLog, uuid } from "./utils";

const PRICING_VERSION = "2026-10-19.v1";
export function getPricingVersion(): string { return PRICING_VERSION; }

export async function debitCreditsForJob(env: Env, uid: string, price: number, templateId: string, modelId: string, options: Record<string, unknown>, inputAssetKeys: string[], idempotencyKey?: string): Promise<{ jobId: string; balanceAfter: number }> {
  if (idempotencyKey) {
    const existing = await getDoc(env, `jobs/idempotency/${idempotencyKey}`);
    if (existing) { safeLog("Idempotent retry detected", { uid, jobId: existing.data.job_id }); return { jobId: existing.data.job_id as string, balanceAfter: existing.data.balance_after as number }; }
  }
  const userDocPath = `users/${uid}`;
  const jobId = uuid();
  const ledgerId = uuid();
  const now = Date.now();
  const txn = await beginTransaction(env);
  try {
    const userDoc = await getDoc(env, userDocPath, txn);
    const currentCredits = (userDoc?.data?.credits as number) ?? 0;
    if (currentCredits < price) { await rollbackTransaction(env, txn); throw new InsufficientCreditsError(`Insufficient credits: have ${currentCredits}, need ${price}`); }
    const balanceAfter = currentCredits - price;
    const docName = (p: string) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${p}`;
    await commitTransaction(env, txn, [
      { update: { name: docName(userDocPath), fields: { credits: toFirestoreValue(balanceAfter), updated_at: toFirestoreValue(now) } } },
      { update: { name: docName(`ledger/${ledgerId}`), fields: { id: toFirestoreValue(ledgerId), uid: toFirestoreValue(uid), type: toFirestoreValue("debit"), amount: toFirestoreValue(price), reason: toFirestoreValue("generation"), balance_after: toFirestoreValue(balanceAfter), pricing_version: toFirestoreValue(PRICING_VERSION), job_id: toFirestoreValue(jobId), transaction_id: toFirestoreValue(idempotencyKey ?? jobId), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
      { update: { name: docName(`jobs/${jobId}`), fields: { id: toFirestoreValue(jobId), uid: toFirestoreValue(uid), template_id: toFirestoreValue(templateId), model_id: toFirestoreValue(modelId), status: toFirestoreValue("debited"), options: toFirestoreValue(options), input_asset_keys: toFirestoreValue(inputAssetKeys), price: toFirestoreValue(price), pricing_version: toFirestoreValue(PRICING_VERSION), balance_after: toFirestoreValue(balanceAfter), created_at: toFirestoreValue(now), updated_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
      ...(idempotencyKey ? [{ update: { name: docName(`jobs/idempotency/${idempotencyKey}`), fields: { job_id: toFirestoreValue(jobId), uid: toFirestoreValue(uid), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } }] : []),
    ]);
    safeLog("Credits debited for job", { uid, jobId, price, balanceAfter });
    return { jobId, balanceAfter };
  } catch (err) { if (err instanceof InsufficientCreditsError) throw err; safeError("Debit transaction failed", { uid, jobId }); throw err; }
}

export async function refundCreditsForJob(env: Env, uid: string, jobId: string, price: number, reason: string): Promise<{ refunded: boolean; balanceAfter: number }> {
  const jobDoc = await getDoc(env, `jobs/${jobId}`);
  if (!jobDoc) throw new Error("JOB_NOT_FOUND");
  if (jobDoc.data.status === "refunded") { safeLog("Job already refunded", { jobId }); return { refunded: false, balanceAfter: jobDoc.data.balance_after as number }; }
  const userDocPath = `users/${uid}`;
  const ledgerId = uuid();
  const now = Date.now();
  const txn = await beginTransaction(env);
  try {
    const userDoc = await getDoc(env, userDocPath, txn);
    const currentCredits = (userDoc?.data?.credits as number) ?? 0;
    const balanceAfter = currentCredits + price;
    const docName = (p: string) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${p}`;
    await commitTransaction(env, txn, [
      { update: { name: docName(userDocPath), fields: { credits: toFirestoreValue(balanceAfter), updated_at: toFirestoreValue(now) } } },
      { update: { name: docName(`ledger/${ledgerId}`), fields: { id: toFirestoreValue(ledgerId), uid: toFirestoreValue(uid), type: toFirestoreValue("credit"), amount: toFirestoreValue(price), reason: toFirestoreValue(`refund:${reason}`), balance_after: toFirestoreValue(balanceAfter), job_id: toFirestoreValue(jobId), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
    ]);
    const { updateDoc } = await import("./firestore");
    await updateDoc(env, `jobs/${jobId}`, { status: "refunded", updated_at: now, balance_after: balanceAfter });
    safeLog("Credits refunded for job", { uid, jobId, price, balanceAfter });
    return { refunded: true, balanceAfter };
  } catch (err) { safeError("Refund transaction failed", { uid, jobId }); throw err; }
}

export async function creditAdReward(env: Env, uid: string, transactionId: string, rewardAmount: number, adUnitId?: string): Promise<{ credited: boolean; balanceAfter: number }> {
  const existing = await getDoc(env, `ad_rewards/${transactionId}`);
  if (existing) { safeLog("Duplicate ad reward", { transactionId }); return { credited: false, balanceAfter: existing.data.balance_after as number }; }
  const userDocPath = `users/${uid}`;
  const ledgerId = uuid();
  const now = Date.now();
  const txn = await beginTransaction(env);
  try {
    const userDoc = await getDoc(env, userDocPath, txn);
    const currentCredits = (userDoc?.data?.credits as number) ?? 0;
    const balanceAfter = currentCredits + rewardAmount;
    const docName = (p: string) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${p}`;
    await commitTransaction(env, txn, [
      { update: { name: docName(userDocPath), fields: { credits: toFirestoreValue(balanceAfter), updated_at: toFirestoreValue(now) } } },
      { update: { name: docName(`ledger/${ledgerId}`), fields: { id: toFirestoreValue(ledgerId), uid: toFirestoreValue(uid), type: toFirestoreValue("credit"), amount: toFirestoreValue(rewardAmount), reason: toFirestoreValue("ad_reward"), balance_after: toFirestoreValue(balanceAfter), transaction_id: toFirestoreValue(transactionId), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
      { update: { name: docName(`ad_rewards/${transactionId}`), fields: { id: toFirestoreValue(transactionId), uid: toFirestoreValue(uid), transaction_id: toFirestoreValue(transactionId), reward_amount: toFirestoreValue(rewardAmount), ad_unit_id: toFirestoreValue(adUnitId ?? ""), verified: toFirestoreValue(true), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
    ]);
    safeLog("Ad reward credited", { uid, transactionId, rewardAmount, balanceAfter });
    return { credited: true, balanceAfter };
  } catch (err) { safeError("Ad reward credit failed", { uid, transactionId }); throw err; }
}

export async function creditPurchase(env: Env, uid: string, purchaseToken: string, productId: string, orderId: string, creditsGranted: number): Promise<{ credited: boolean; balanceAfter: number }> {
  const existing = await getDoc(env, `purchases/${purchaseToken}`);
  if (existing) { safeLog("Duplicate purchase", {}); return { credited: false, balanceAfter: existing.data.balance_after as number }; }
  const userDocPath = `users/${uid}`;
  const ledgerId = uuid();
  const now = Date.now();
  const txn = await beginTransaction(env);
  try {
    const userDoc = await getDoc(env, userDocPath, txn);
    const currentCredits = (userDoc?.data?.credits as number) ?? 0;
    const balanceAfter = currentCredits + creditsGranted;
    const docName = (p: string) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${p}`;
    await commitTransaction(env, txn, [
      { update: { name: docName(userDocPath), fields: { credits: toFirestoreValue(balanceAfter), updated_at: toFirestoreValue(now) } } },
      { update: { name: docName(`ledger/${ledgerId}`), fields: { id: toFirestoreValue(ledgerId), uid: toFirestoreValue(uid), type: toFirestoreValue("credit"), amount: toFirestoreValue(creditsGranted), reason: toFirestoreValue("purchase"), balance_after: toFirestoreValue(balanceAfter), transaction_id: toFirestoreValue(purchaseToken), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
      { update: { name: docName(`purchases/${purchaseToken}`), fields: { uid: toFirestoreValue(uid), product_id: toFirestoreValue(productId), purchase_token: toFirestoreValue(purchaseToken), order_id: toFirestoreValue(orderId), credits_granted: toFirestoreValue(creditsGranted), status: toFirestoreValue("verified"), verified_at: toFirestoreValue(now), created_at: toFirestoreValue(now) } }, currentDocument: { exists: false } },
    ]);
    safeLog("Purchase credited", { uid, productId, creditsGranted, balanceAfter });
    return { credited: true, balanceAfter };
  } catch (err) { safeError("Purchase credit failed", { uid, productId }); throw err; }
}

export class InsufficientCreditsError extends Error { constructor(message: string) { super(message); this.name = "InsufficientCreditsError"; } }
