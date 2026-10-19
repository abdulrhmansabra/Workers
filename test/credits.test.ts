import { describe, it, expect } from "vitest";
import { InsufficientCreditsError } from "../src/credits";

describe("InsufficientCreditsError", () => {
  it("should be an Error with the correct name", () => {
    const err = new InsufficientCreditsError("Not enough credits");
    expect(err).toBeInstanceOf(Error); expect(err.name).toBe("InsufficientCreditsError"); expect(err.message).toBe("Not enough credits");
  });
});

describe("Pricing version", () => {
  it("should return a non-empty version string", async () => {
    const { getPricingVersion } = await import("../src/credits");
    const version = getPricingVersion();
    expect(typeof version).toBe("string"); expect(version.length).toBeGreaterThan(0);
  });
});

describe("Idempotency design", () => {
  it("should use UUID v4 format for job IDs", async () => {
    const { uuid } = await import("../src/utils");
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
