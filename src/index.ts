import type { Env } from "./types";
import { corsResponse, errorResponse, safeError, HttpError } from "./utils";
import { addRoute, matchRoute } from "./router";
import { initModels } from "./crun";
import { healthHandler } from "./routes/health";
import { modelsHandler } from "./routes/models";
import { templatesListHandler, templateDetailHandler } from "./routes/templates";
import { balanceHandler } from "./routes/balance";
import { quoteHandler } from "./routes/quote";
import { createGenerationHandler, getGenerationHandler } from "./routes/generations";
import { uploadHandler, fileAccessHandler } from "./routes/uploads";
import { admobSSVHandler } from "./routes/admob-ssv";
import { crunWebhookHandler } from "./routes/crun-webhook";
import { purchaseHandler } from "./routes/purchases";
import { enqueueCrunTemplateSync, syncCrunTemplatePage } from "./crun-templates";
import type { CrunTemplateSyncMessage } from "./types";

addRoute("GET", "/health", healthHandler);
addRoute("GET", "/v1/models", modelsHandler);
addRoute("GET", "/v1/templates", templatesListHandler);
addRoute("GET", "/v1/templates/:templateId", templateDetailHandler);
addRoute("GET", "/v1/me/balance", balanceHandler);
addRoute("POST", "/v1/generations/quote", quoteHandler);
addRoute("POST", "/v1/generations", createGenerationHandler);
addRoute("GET", "/v1/generations/:jobId", getGenerationHandler);
addRoute("POST", "/v1/uploads", uploadHandler);
addRoute("GET", "/v1/files/:key", fileAccessHandler);
addRoute("POST", "/v1/purchases", purchaseHandler);
addRoute("GET", "/v1/admob-ssv", admobSSVHandler);
addRoute("POST", "/v1/admob-ssv", admobSSVHandler);
addRoute("POST", "/v1/crun-webhook", crunWebhookHandler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN ?? "*";
    try { initModels(); } catch { safeError("Model init failed", {}); }
    if (request.method === "OPTIONS") return corsResponse(origin);
    const url = new URL(request.url);
    const match = matchRoute(request.method, url.pathname);
    if (!match) return errorResponse("NOT_FOUND", `No route for ${request.method} ${url.pathname}`, 404, origin);
    try {
      const response = await match.handler(request, env, ctx, match.params);
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", origin);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.code, err.message, err.status, origin);
      safeError("Unhandled error", { path: url.pathname, method: request.method, error: (err as Error).message.slice(0, 200) });
      return errorResponse("INTERNAL_ERROR", "An unexpected error occurred", 500, origin);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledCatalogEnqueue(env));
  },
  async queue(batch: MessageBatch<CrunTemplateSyncMessage>, env: Env): Promise<void> {
    // Process messages sequentially within a small batch to keep each invocation
    // safely below the Workers subrequest budget. Failed messages are retried by Queue.
    for (const message of batch.messages) {
      try {
        await syncCrunTemplatePage(env, message.body.provider, message.body.page);
        message.ack();
      } catch (error) {
        safeError("CRUN catalog page task failed", {
          provider: message.body.provider,
          page: message.body.page,
          error: error instanceof Error ? error.message.slice(0, 120) : "unknown",
        });
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};

async function runScheduledCatalogEnqueue(env: Env): Promise<void> {
  safeLog("Scheduled CRUN catalog queueing started", {});
  try {
    const result = await enqueueCrunTemplateSync(env);
    safeLog("Scheduled CRUN catalog tasks queued", result);
  } catch (error) {
    safeError("Scheduled CRUN catalog queueing failed", {
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    });
  }
}
