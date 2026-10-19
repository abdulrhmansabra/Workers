import type { Env, JobDoc, JobStatus } from "../types";
import { json, HttpError, parseJsonBody, safeLog, safeError } from "../utils";
import { getValidTemplate, validateOptions, calculatePrice } from "../pricing";
import { getPricingVersion, debitCreditsForJob, refundCreditsForJob, InsufficientCreditsError } from "../credits";
import { getAdapter } from "../crun";
import { getDoc, updateDoc, setDoc } from "../firestore";
import { requireAuth } from "../middleware/auth";
import type { RouteHandler } from "../router";

interface GenerationRequestBody { template_id: string; options: Record<string, unknown>; input_asset_keys: string[]; idempotency_key?: string; }

export const createGenerationHandler: RouteHandler = async (request, env: Env) => {
  const auth = await requireAuth(request, env);
  const body = await parseJsonBody<GenerationRequestBody>(request);
  if (!body.template_id) throw new HttpError(400, "MISSING_TEMPLATE", "template_id is required");
  if (!Array.isArray(body.input_asset_keys)) throw new HttpError(400, "INVALID_INPUT", "input_asset_keys must be an array");
  const template = await getValidTemplate(env, body.template_id);
  validateOptions(template, body.options ?? {});
  const breakdown = calculatePrice(template, body.options ?? {});
  for (const key of body.input_asset_keys) { if (typeof key !== "string" || !key.includes(`/${auth.uid}/`)) throw new HttpError(403, "ASSET_NOT_OWNED", `You do not own asset: ${key}`); }
  let jobId: string; let balanceAfter: number;
  try { const result = await debitCreditsForJob(env, auth.uid, breakdown.total, template.id, template.model_id, body.options ?? {}, body.input_asset_keys, body.idempotency_key); jobId = result.jobId; balanceAfter = result.balanceAfter; }
  catch (err) { if (err instanceof InsufficientCreditsError) throw new HttpError(402, "INSUFFICIENT_CREDITS", err.message); throw err; }
  try {
    const adapter = getAdapter(template.model_id);
    const crunResult = await adapter.createJob({ model_id: template.model_id, options: body.options ?? {}, image_asset_keys: body.input_asset_keys, reference_video_url: template.reference_video_url, webhook_url: env.WORKER_BASE_URL && env.CRUN_WEBHOOK_SECRET ? `${env.WORKER_BASE_URL.replace(/\\/$/, "")}/v1/crun-webhook?token=${encodeURIComponent(env.CRUN_WEBHOOK_SECRET)}` : undefined }, env);
    await updateDoc(env, `jobs/${jobId}`, { status: "submitted", crun_job_id: crunResult.crun_job_id, crun_response: crunResult.raw, updated_at: Date.now() });
    await setDoc(env, `jobs_by_crun_id/${crunResult.crun_job_id}`, { job_id: jobId, uid: auth.uid, created_at: Date.now() });
    safeLog("Generation job submitted", { jobId, crunJobId: crunResult.crun_job_id });
    return json({ ok: true, data: { job_id: jobId, status: "submitted" as JobStatus, price: breakdown.total, pricing_version: getPricingVersion() } }, 201);
  } catch (err) {
    safeError("Crun submission failed, refunding", { jobId });
    try { await refundCreditsForJob(env, auth.uid, jobId, breakdown.total, "crun_submit_failed"); } catch { safeError("Refund also failed", { jobId }); }
    await updateDoc(env, `jobs/${jobId}`, { status: "failed", error: "CRUN_SUBMISSION_FAILED", updated_at: Date.now() });
    throw new HttpError(502, "GENERATION_FAILED", "Failed to submit generation to provider");
  }
};

export const getGenerationHandler: RouteHandler = async (request, env: Env, ctx, params) => {
  const auth = await requireAuth(request, env);
  const jobId = params.jobId;
  if (!jobId) throw new HttpError(400, "MISSING_PARAM", "jobId is required");
  const jobDoc = await getDoc(env, `jobs/${jobId}`);
  if (!jobDoc) throw new HttpError(404, "JOB_NOT_FOUND", "Job not found");
  if (jobDoc.data.uid !== auth.uid) throw new HttpError(403, "FORBIDDEN", "You do not own this job");
  const job = jobDoc.data as unknown as JobDoc;
  if ((job.status === "submitted" || job.status === "processing") && job.crun_job_id) {
    try {
      const adapter = getAdapter(job.model_id);
      const status = await adapter.getJobStatus(job.crun_job_id, env);
      if (status.status === "succeeded" && status.result_url) {
        const resultKey = `outputs/${auth.uid}/${jobId}.mp4`;
        const resp = await fetch(status.result_url);
        if (resp.ok && resp.body) await env.R2_BUCKET.put(resultKey, resp.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { owner_uid: auth.uid } });
        await updateDoc(env, `jobs/${jobId}`, { status: "succeeded", output_asset_key: resultKey, crun_response: status.raw, completed_at: Date.now(), updated_at: Date.now() });
      } else if (status.status === "failed") {
        await refundCreditsForJob(env, auth.uid, jobId, job.price, "crun_job_failed");
        await updateDoc(env, `jobs/${jobId}`, { status: "failed", error: status.error ?? "CRUN_JOB_FAILED", completed_at: Date.now(), updated_at: Date.now() });
      } else { await updateDoc(env, `jobs/${jobId}`, { status: "processing", crun_response: status.raw, updated_at: Date.now() }); }
    } catch { safeError("Status poll failed", { jobId }); }
    const updated = await getDoc(env, `jobs/${jobId}`);
    if (updated) return json({ ok: true, data: sanitizeJob(updated.data as unknown as JobDoc) });
  }
  return json({ ok: true, data: sanitizeJob(job) });
};

function sanitizeJob(job: JobDoc): Partial<JobDoc> {
  return { id: job.id, template_id: job.template_id, model_id: job.model_id, status: job.status, options: job.options, price: job.price, pricing_version: job.pricing_version, error: job.error, created_at: job.created_at, updated_at: job.updated_at, completed_at: job.completed_at };
}
