import { describe, it, expect } from "vitest";

describe("Route matching", () => {
  it("should match static paths", async () => {
    const { matchRoute } = await import("../src/router");
    const match = matchRoute("GET", "/health");
    expect(match).not.toBeNull();
  });
  it("should match paths with parameters", async () => {
    const { matchRoute } = await import("../src/router");
    const match = matchRoute("GET", "/v1/templates/my-template-id");
    expect(match).not.toBeNull(); expect(match!.params.templateId).toBe("my-template-id");
  });
  it("should return null for unknown paths", async () => {
    const { matchRoute } = await import("../src/router");
    expect(matchRoute("GET", "/v1/unknown-path")).toBeNull();
  });
  it("should return null for wrong method", async () => {
    const { matchRoute } = await import("../src/router");
    expect(matchRoute("DELETE", "/health")).toBeNull();
  });
});
