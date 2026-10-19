import { describe, it, expect } from "vitest";
import { uuid } from "../src/utils";
import { getPricingVersion } from "../src/credits";
import { calculatePrice, validateOptions } from "../src/pricing";
import type { TemplateDoc } from "../src/types";

describe("Concurrent request handling: Idempotency keys", () => {
  it("should generate unique IDs even in rapid succession", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(uuid());
    expect(ids.size).toBe(10000);
  });
  it("should use consistent pricing version", () => {
    const versions = new Set<string>();
    for (let i = 0; i < 100; i++) versions.add(getPricingVersion());
    expect(versions.size).toBe(1);
  });
});

describe("Concurrent request handling: Price consistency", () => {
  const template: TemplateDoc = { id: "t1", name: "T", description: "", model_id: "m1", active: true, preview_video_url: "", base_cost: 15, option_pricing: { speed: { normal: 0, fast: 10 } }, supported_options: [{ key: "speed", label: "Speed", type: "select", required: true, allowed_values: ["normal", "fast"], default: "normal" }], created_at: 0, updated_at: 0 };
  it("should produce identical price for same options", () => {
    const opts = { speed: "fast" };
    const prices = new Set<number>();
    for (let i = 0; i < 100; i++) { validateOptions(template, opts); prices.add(calculatePrice(template, opts).total); }
    expect(prices.size).toBe(1); expect(prices.has(25)).toBe(true);
  });
});
