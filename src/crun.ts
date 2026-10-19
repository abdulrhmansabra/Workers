import type { CrunCreateJobInput, CrunCreateJobResult, CrunJobStatus, CrunModelAdapter, Env, ModelInfo } from "./types";
import { safeError, safeLog } from "./utils";
import { registerAllowedModel } from "./pricing";

const adapterRegistry = new Map<string, CrunModelAdapter>();
const modelInfoRegistry = new Map<string, ModelInfo>();

export function registerModel(adapter: CrunModelAdapter, info: ModelInfo): void {
  adapterRegistry.set(adapter.model_id, adapter);
  modelInfoRegistry.set(adapter.model_id, info);
  registerAllowedModel(adapter.model_id);
  safeLog("Crun model registered", { model_id: adapter.model_id });
}

// Crun model IDs are configured by an administrator in Firestore. The adapter
// is generic because Crun uses one CreateTask/TaskInfo API for its model catalog.
export function getAdapter(modelId: string): CrunModelAdapter {
  const existing = adapterRegistry.get(modelId);
  if (existing) return existing;
  if (!modelId || modelId.includes("/") || modelId.includes("..")) throw new Error("INVALID_CRUN_MODEL_ID");
  return new GenericCrunAdapter(modelId);
}

export function getModelInfo(modelId: string): ModelInfo | undefined { return modelInfoRegistry.get(modelId); }
export function listModels(): ModelInfo[] { return Array.from(modelInfoRegistry.values()); }

async function crunRequest(env: Env, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!env.CRUN_API_KEY) throw new Error("CRUN_API_KEY is not configured");
  const base = (env.CRUN_BASE_URL || "https://api.crun.ai").replace(/\/+$/, "");
  const timeoutMs = Math.max(1000, Math.min(Number(env.CRUN_TIMEOUT_MS) || 30000, 120000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { "X-API-KEY": env.CRUN_API_KEY, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await resp.text();
    let payload: Record<string, unknown>;
    try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
    catch { throw new Error("CRUN_INVALID_JSON_RESPONSE"); }
    if (!resp.ok) {
      safeError("Crun API request failed", { status: resp.status, path });
      throw new Error(`CRUN_HTTP_${resp.status}`);
    }
    if (typeof payload.code === "number" && payload.code !== 200) {
      safeError("Crun API returned error", { code: payload.code, path });
      throw new Error("CRUN_API_ERROR");
    }
    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("CRUN_INVALID_RESPONSE");
    return data as Record<string, unknown>;
  } finally { clearTimeout(timeout); }
}

export async function createTemplateJob(
  provider: "kling" | "bytedance" | "vidu",
  templateId: string,
  inputAssetKeys: string[],
  options: Record<string, unknown>,
  env: Env,
  webhookUrl?: string,
): Promise<CrunCreateJobResult> {
  const publicBase = (env.R2_PUBLIC_BASE_URL ?? "").replace(/\\/+$/, "");
  if (!publicBase) throw new Error("R2_PUBLIC_BASE_URL_REQUIRED_FOR_IMAGE_INPUT");
  if (inputAssetKeys.length === 0) throw new Error("TEMPLATE_IMAGE_REQUIRED");
  const imageUrls = inputAssetKeys.map((key) =>
    publicBase + "/" + key.split("/").map(encodeURIComponent).join("/"),
  );
  const input: Record<string, unknown> = { ...options };
  delete input.template_id;
  delete input.img_urls;
  delete input.images;
  if (provider === "kling") {
    input.template_id = templateId;
    input.img_urls = imageUrls;
  } else if (provider === "bytedance") {
    input.template_id = templateId;
    input.img_urls = imageUrls;
  } else {
    input.template = templateId;
    input.images = imageUrls.length === 1 ? imageUrls[0] : imageUrls;
  }
  const model = provider + "/template";
  const requestBody: Record<string, unknown> = { model, input };
  if (webhookUrl) requestBody.callback_url = webhookUrl;
  const raw = await crunRequest(env, "POST", "/api/v1/client/job/CreateTask", requestBody);
  const taskId = raw.task_id ?? raw.id;
  if (typeof taskId !== "string" || !taskId) throw new Error("CRUN_TASK_ID_MISSING");
  return { crun_job_id: taskId, status: normalizeStatus(raw.status), raw };
}

class GenericCrunAdapter implements CrunModelAdapter {
  constructor(public readonly model_id: string) {}
  async createJob(input: CrunCreateJobInput, env: Env): Promise<CrunCreateJobResult> {
    const taskInput: Record<string, unknown> = { ...input.options };
    const prompt = input.prompt ?? (typeof input.options.prompt === "string" ? input.options.prompt : undefined);
    if (prompt) taskInput.prompt = prompt;
    if (input.image_asset_keys?.length) {
      const publicBase = (env.R2_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
      if (!publicBase) throw new Error("R2_PUBLIC_BASE_URL_REQUIRED_FOR_IMAGE_INPUT");
      taskInput.image_urls = input.image_asset_keys.map((key) => `${publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`);
    }
    if (input.reference_video_url) taskInput.video_url = input.reference_video_url;
    const requestBody: Record<string, unknown> = { model: this.model_id, input: taskInput };
    if (input.webhook_url) requestBody.callback_url = input.webhook_url;
    // Do not automatically retry CreateTask: a timeout can occur after Crun
    // accepted the job and retrying could create a duplicate billable task.
    const raw = await crunRequest(env, "POST", "/api/v1/client/job/CreateTask", requestBody);
    const taskId = raw.task_id ?? raw.id;
    if (typeof taskId !== "string" || !taskId) throw new Error("CRUN_TASK_ID_MISSING");
    return { crun_job_id: taskId, status: normalizeStatus(raw.status), raw };
  }
  async getJobStatus(crun_job_id: string, env: Env): Promise<CrunJobStatus> {
    const raw = await crunRequest(env, "GET", `/api/v1/client/job/TaskInfo?task_id=${encodeURIComponent(crun_job_id)}`);
    const result = raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : {};
    const urls = Array.isArray(result.media_urls) ? result.media_urls : [];
    const resultUrl = urls.find((value): value is string => typeof value === "string" && /^https:\/\//i.test(value));
    const status = normalizeStatus(raw.status);
    return {
      crun_job_id,
      status: status === "succeeded" && resultUrl ? "succeeded" : status === "failed" ? "failed" : "processing",
      result_url: resultUrl,
      error: typeof result.message === "string" ? result.message : typeof raw.message === "string" ? raw.message : undefined,
      raw,
    };
  }
}

function normalizeStatus(value: unknown): "submitted" | "processing" | "succeeded" | "failed" {
  const status = String(value ?? "").toLowerCase();
  if (["success", "succeeded", "completed", "complete"].includes(status)) return "succeeded";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["pending", "queued", "created"].includes(status)) return "submitted";
  return "processing";
}

export function initModels(): void {
  // The active Firestore model/template catalog is authoritative; no provider
  // model is hard-coded or enabled without an administrator activating it.
}

export interface CrunWebhookPayload { job_id: string; status: "processing" | "succeeded" | "failed"; result_url?: string; error?: string; [key: string]: unknown; }

export function parseWebhookPayload(body: unknown): CrunWebhookPayload {
  if (typeof body !== "object" || body === null) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  const payload = body as Record<string, unknown>;
  const jobId = payload.job_id ?? payload.task_id;
  const rawStatus = String(payload.status ?? "").toLowerCase();
  if (typeof jobId !== "string" || !jobId || !["processing", "success", "succeeded", "completed", "failed", "failure", "error"].includes(rawStatus)) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  const urls = Array.isArray(result.media_urls) ? result.media_urls : [];
  const resultUrl = payload.result_url ?? urls.find((value) => typeof value === "string");
  const status = ["success", "succeeded", "completed"].includes(rawStatus) ? "succeeded" : ["failed", "failure", "error"].includes(rawStatus) ? "failed" : "processing";
  return { ...payload, job_id: jobId, status, result_url: typeof resultUrl === "string" ? resultUrl : undefined, error: typeof payload.error === "string" ? payload.error : undefined };
}

export async function reconcileJobStatus(env: Env, crunJobId: string, modelId: string): Promise<CrunJobStatus | null> {
  try { return await getAdapter(modelId).getJobStatus(crunJobId, env); }
  catch { safeError("Job reconciliation failed", { crunJobId, modelId }); return null; }
}
