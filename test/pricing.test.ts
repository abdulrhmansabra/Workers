import { describe, it, expect } from "vitest";
import { calculatePrice, validateOptions } from "../src/pricing";
import { HttpError } from "../src/utils";
import type { TemplateDoc } from "../src/types";

const mockTemplate: TemplateDoc = {
  id: "test-template", name: "Test Template", description: "A test template",
  model_id: "test-model", active: true, preview_video_url: "https://example.com/preview.mp4",
  base_cost: 10, option_pricing: { duration: { "15": 5, "30": 10 }, quality: { "hd": 0, "4k": 20 } },
  supported_options: [
    { key: "duration", label: "Duration", type: "select", required: true, allowed_values: ["15", "30"], default: "15" },
    { key: "quality", label: "Quality", type: "select", required: false, allowed_values: ["hd", "4k"], default: "hd" },
  ],
  created_at: 0, updated_at: 0,
};

describe("calculatePrice", () => {
  it("should calculate base cost with no options", () => {
    const result = calculatePrice(mockTemplate, {});
    expect(result.base).toBe(10); expect(result.total).toBe(10); expect(result.options).toEqual({});
  });
  it("should add option costs", () => {
    const result = calculatePrice(mockTemplate, { duration: "30", quality: "4k" });
    expect(result.base).toBe(10); expect(result.options.duration).toBe(10); expect(result.options.quality).toBe(20); expect(result.total).toBe(40);
  });
  it("should handle free options", () => {
    const result = calculatePrice(mockTemplate, { duration: "15", quality: "hd" });
    expect(result.options.duration).toBe(5); expect(result.options.quality).toBe(0); expect(result.total).toBe(15);
  });
});

describe("validateOptions", () => {
  it("should accept valid options", () => { expect(() => validateOptions(mockTemplate, { duration: "15", quality: "hd" })).not.toThrow(); });
  it("should reject missing required options", () => { expect(() => validateOptions(mockTemplate, {})).toThrow(HttpError); });
  it("should reject invalid select values", () => { expect(() => validateOptions(mockTemplate, { duration: "999" })).toThrow(HttpError); });
  it("should reject unknown options", () => { expect(() => validateOptions(mockTemplate, { duration: "15", hack: "free" })).toThrow(HttpError); });
});
