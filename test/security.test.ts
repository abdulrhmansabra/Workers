import { describe, it, expect } from "vitest";
import { HttpError } from "../src/utils";
import { InsufficientCreditsError } from "../src/credits";
import { validateOptions, calculatePrice } from "../src/pricing";
import { validateFileMetadata, generateObjectKey } from "../src/r2";
import { SSVError } from "../src/admob";
import { AuthError } from "../src/auth";
import type { TemplateDoc } from "../src/types";

describe("Security: Insufficient credits", () => {
  it("InsufficientCreditsError is a proper Error", () => {
    const err = new InsufficientCreditsError("have 5, need 10");
    expect(err).toBeInstanceOf(Error); expect(err.name).toBe("InsufficientCreditsError");
  });
});

describe("Security: Price manipulation prevention", () => {
  const template: TemplateDoc = { id: "t1", name: "T", description: "", model_id: "m1", active: true, preview_video_url: "", base_cost: 10, option_pricing: { quality: { hd: 0, "4k": 20 } }, supported_options: [{ key: "quality", label: "Q", type: "select", required: false, allowed_values: ["hd", "4k"], default: "hd" }], created_at: 0, updated_at: 0 };
  it("rejects unknown options", () => { expect(() => validateOptions(template, { quality: "hd", price: 0 })).toThrow(HttpError); });
  it("calculates price only from server-defined pricing", () => { expect(calculatePrice(template, { quality: "4k" }).total).toBe(30); });
});

describe("Security: File ownership", () => {
  it("object key embeds uid", () => { expect(generateObjectKey("user-abc", "image/png")).toContain("user-abc"); });
  it("rejects invalid MIME types", () => { expect(() => validateFileMetadata("application/javascript", 1024)).toThrow(HttpError); });
  it("rejects oversized files", () => { expect(() => validateFileMetadata("video/mp4", 500 * 1024 * 1024, 50)).toThrow(HttpError); });
});

describe("Security: Authentication errors", () => {
  it("AuthError has proper code", () => { expect(new AuthError("TOKEN_EXPIRED", "expired").code).toBe("TOKEN_EXPIRED"); });
});

describe("Security: AdMob SSV", () => {
  it("SSVError has proper code", () => { expect(new SSVError("INVALID_SIGNATURE", "bad").code).toBe("INVALID_SIGNATURE"); });
});

describe("Security: Safe logging", () => {
  it("safeLog should redact keys and tokens", async () => {
    const { safeLog } = await import("../src/utils");
    const originalLog = console.log;
    let captured = "";
    console.log = (msg: string) => { captured = msg; };
    safeLog("test", { api_key: "secret123", token: "tok456", safe_field: "visible" });
    console.log = originalLog;
    expect(captured).toContain("[REDACTED]");
    expect(captured).not.toContain("secret123");
    expect(captured).toContain("visible");
  });
});

describe("Security: Idempotency", () => {
  it("generates unique UUIDs", async () => {
    const { uuid } = await import("../src/utils");
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(uuid());
    expect(ids.size).toBe(1000);
  });
});
