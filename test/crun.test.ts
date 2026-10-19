import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "../src/crun";
import type { Env } from "../src/types";

const env = {
  CRUN_BASE_URL: "https://api.crun.ai",
  CRUN_API_KEY: "ak_test_key",
  CRUN_TIMEOUT_MS: "5000",
  R2_PUBLIC_BASE_URL: "https://media.example.test",
} as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("Crun.ai adapter", () => {
  it("submits a task using Crun's API-key header and CreateTask payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: { task_id: "task-123", status: "pending" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAdapter("video-model-id").createJob({
      model_id: "video-model-id",
      prompt: "a cinematic sunrise",
      options: { duration: 5 },
      image_asset_keys: [],
    }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.crun.ai/api/v1/client/job/CreateTask");
    expect(new Headers(init.headers).get("X-API-KEY")).toBe("ak_test_key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "video-model-id",
      input: { duration: 5, prompt: "a cinematic sunrise" },
    });
    expect(result.crun_job_id).toBe("task-123");
    expect(result.status).toBe("submitted");
  });

  it("reads completed task media from TaskInfo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      data: {
        task_id: "task-123",
        status: "success",
        result: { media_urls: ["https://cdn.example.test/result.mp4"] },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAdapter("video-model-id").getJobStatus("task-123", env);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.crun.ai/api/v1/client/job/TaskInfo?task_id=task-123");
    expect(result.status).toBe("succeeded");
    expect(result.result_url).toBe("https://cdn.example.test/result.mp4");
  });

  it("fails closed when Crun returns an API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 400,
      message: "invalid model",
      data: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getAdapter("bad-model").createJob({
      model_id: "bad-model", options: {}, image_asset_keys: [],
    }, env)).rejects.toThrow("CRUN_API_ERROR");
  });
});
