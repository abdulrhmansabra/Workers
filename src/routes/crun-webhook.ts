import type { Env, JobDoc } from "../types";
import { json, HttpError, safeLog, safeError, parseJsonBody } from "../utils";
import { parseWebhookPayload } from "../crun";
import { getDoc, updateDoc } from "../firestore";
import { refundCreditsForJob } from "../credits";
import type { RouteHandler } from "../router";

export const crunWebhookHandler: RouteHandler = async (request, env: Env) => {
  const body = await parseJsonBody(request);
  let payload;
  try { payload = parseWebhookPayload(body); } catch { throw new HttpError(400, "INVALID_WEBHOOK", "Invalid webhook payload"); }
  const indexDoc = await getDoc(env, `jobs_by_crun_id/${payload.job_id}`);
  if (!indexDoc) { safeLog("Webhook for unknown job", { crunJobId: payload.job_id }); return json({ ok: true, data: { acknowledged: true, matched: false } }); }
  const jobId = indexDoc.data.job_id as string;
  const uid = indexDoc.data.uid as string;
  const jobDoc = await getDoc(env, `jobs/${jobId}`);
  if (!jobDoc) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found");
  const job = jobDoc.data as unknown as JobDoc;
  if (payload.status === "succeeded" && payload.result_url) {
    try {
      const resultKey = `outputs/${uid}/${jobId}.mp4`;
      const resp = await fetch(payload.result_url);
      if (!resp.ok || !resp.body) throw new Error("DOWNLOAD_FAILED");
      await env.R2_BUCKET.put(resultKey, resp.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { owner_uid: uid } });
      await updateDoc(env, `jobs/${jobId}`, { status: "succeeded", output_asset_key: resultKey, crun_response: payload as unknown as Record<string, unknown>, completed_at: Date.now(), updated_at: Date.now() });
      safeLog("Webhook: job succeeded", { jobId });
    } catch { safeError("Webhook: download failed", { jobId }); throw new HttpError(500, "DOWNLOAD_FAILED", "Failed to download result"); }
  } else if (payload.status === "failed") {
    try { await refundCreditsForJob(env, uid, jobId, job.price, "crun_webhook_failed"); } catch { safeError("Webhook: refund failed", { jobId }); }
    await updateDoc(env, `jobs/${jobId}`, { status: "failed", error: payload.error ?? "CRUN_WEBHOOK_FAILED", completed_at: Date.now(), updated_at: Date.now() });
    safeLog("Webhook: job failed, refunded", { jobId });
  } else { await updateDoc(env, `jobs/${jobId}`, { status: "processing", crun_response: payload as unknown as Record<string, unknown>, updated_at: Date.now() }); }
  return json({ ok: true, data: { acknowledged: true, matched: true, job_id: jobId } });
};
