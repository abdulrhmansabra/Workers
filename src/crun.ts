import type { CrunCreateJobInput, CrunCreateJobResult, CrunJobStatus, CrunModelAdapter, Env, ModelInfo } from "./types";
import { safeError, safeLog } from "./utils";
import { registerAllowedModel } from "./pricing";

const adapterRegistry = new Map<string, CrunModelAdapter>();
const modelInfoRegistry = new Map<string, ModelInfo>();

export function registerModel(adapter: CrunModelAdapter, info: ModelInfo): void {
  adapterRegistry.set(adapter.model_id, adapter);
  modelInfoRegistry.set(adapter.model_id, info);
  registerAllowedModel(adapter.model_id);
  safeLog("Model registered", { model_id: adapter.model_id });
}

export function getAdapter(modelId: string): CrunModelAdapter {
  const adapter = adapterRegistry.get(modelId);
  if (!adapter) throw new Error(`MODEL_NOT_REGISTERED: ${modelId}`);
  return adapter;
}

export function getModelInfo(modelId: string): ModelInfo | undefined { return modelInfoRegistry.get(modelId); }
export function listModels(): ModelInfo[] { return Array.from(modelInfoRegistry.values()); }

async function crunRequest(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  const url = `${env.CRUN_BASE_URL}${path}`;
  const timeoutMs = parseInt(env.CRUN_TIMEOUT_MS ?? "30000", 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers: { Authorization: `Bearer ${env.CRUN_API_KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
  } finally { clearTimeout(timeout); }
}

abstract class BaseCrunAdapter implements CrunModelAdapter {
  abstract model_id: string;
  protected abstract buildRequestBody(input: CrunCreateJobInput): Record<string, unknown>;
  protected abstract parseCreateResponse(raw: Record<string, unknown>): CrunCreateJobResult;
  protected abstract parseStatusResponse(raw: Record<string, unknown>): CrunJobStatus;
  async createJob(input: CrunCreateJobInput, env: Env): Promise<CrunCreateJobResult> {
    const requestBody = this.buildRequestBody(input);
    if (input.webhook_url) (requestBody as Record<string, unknown>).webhook_url = input.webhook_url;
    const resp = await crunRequest(env, "POST", "/v1/jobs", requestBody);
    if (!resp.ok) { safeError("Crun createJob failed", { model_id: this.model_id, status: resp.status }); throw new Error(`CRUN_CREATE_FAILED: ${resp.status}`); }
    return this.parseCreateResponse(await resp.json() as Record<string, unknown>);
  }
  async getJobStatus(crun_job_id: string, env: Env): Promise<CrunJobStatus> {
    const resp = await crunRequest(env, "GET", `/v1/generation_generation_jobs/${crun_job_id}`);
    if (!resp.ok) { safeError("Crun getJobStatus failed", { model_id: this.model_id, status: resp.status }); throw new Error(`CRUN_STATUS_FAILED: ${resp.status}`); }
    return this.parseStatusResponse(await resp.json() as Record<string, unknown>);
  }
}

export function initModels(): void {
  safeLog("Model registry initialized (no models enabled yet - verify Crun.ai docs first)");
}

export interface CrunWebhookPayload { job_id: string; status: "processing" | "succeeded" | "failed"; result_url?: string; error?: string; [key: string]: unknown; }

export function parseWebhookPayload(body: unknown): CrunWebhookPayload {
  if (typeof body !== "object" || body === null) throw new Error("INVALID_WEBHOOK_PAYLOAD");
  const payload = body as Record<string, unknown>;
  if (typeof payload.job_id !== "string" || typeof payload.status !== "string") throw new Error("INVALID_WEBHOOK_PAYLOAD");
  return { job_id: payload.job_id, status: payload.status as "processing" | "succeeded" | "failed", result_url: payload.result_url as string | undefined, error: payload.error as string | undefined, ...payload };
}

export async function reconcileJobStatus(env: Env, crunJobId: string, modelId: string): Promise<CrunJobStatus | null> {
  try { const adapter = getAdapter(modelId); return await adapter.getJobStatus(crunJobId, env); }
  catch { safeError("Job reconciliation failed", { crunJobId, modelId }); return null; }
}
