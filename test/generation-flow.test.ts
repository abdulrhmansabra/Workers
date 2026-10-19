import { describe, it, expect } from "vitest";
import { calculatePrice, validateOptions } from "../src/pricing";
import { getPricingVersion } from "../src/credits";
import type { TemplateDoc } from "../src/types";

const mockTemplate: TemplateDoc = {
  id: "tpl-video-15s", name: "15s Video", description: "Generate a 15-second AI short video",
  model_id: "crun-video-v1", active: true, preview_video_url: "https://cdn.example.com/preview.mp4",
  base_cost: 10, option_pricing: { duration: { "15": 0, "30": 10 }, quality: { "sd": 0, "hd": 5, "4k": 20 } },
  supported_options: [
    { key: "duration", label: "Duration", type: "select", required: true, allowed_values: ["15", "30"], default: "15" },
    { key: "quality", label: "Quality", type: "select", required: false, allowed_values: ["sd", "hd", "4k"], default: "sd" },
    { key: "prompt", label: "Prompt", type: "text", required: true },
  ],
  created_at: Date.now(), updated_at: Date.now(),
};

describe("Generation flow: Quote", () => {
  it("should calculate price for minimal options", () => {
    validateOptions(mockTemplate, { duration: "15", prompt: "a cat" });
    expect(calculatePrice(mockTemplate, { duration: "15", prompt: "a cat" }).total).toBe(10);
  });
  it("should calculate price with premium options", () => {
    validateOptions(mockTemplate, { duration: "30", quality: "4k", prompt: "a dog" });
    expect(calculatePrice(mockTemplate, { duration: "30", quality: "4k", prompt: "a dog" }).total).toBe(40);
  });
  it("should record pricing version", () => { expect(getPricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/); });
});

describe("Generation flow: Validation", () => {
  it("should reject missing required prompt", () => { expect(() => validateOptions(mockTemplate, { duration: "15" })).toThrow(/Missing required option: prompt/); });
  it("should reject invalid duration value", () => { expect(() => validateOptions(mockTemplate, { duration: "60", prompt: "test" })).toThrow(/invalid value/); });
});
