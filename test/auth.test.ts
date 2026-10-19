import { describe, it, expect, vi } from "vitest";
import { AuthError } from "../src/auth";

describe("AuthError", () => {
  it("should create an AuthError with code and message", () => {
    const err = new AuthError("TEST_CODE", "test message");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("AuthError");
  });
});

describe("Token structure validation", () => {
  it("should reject tokens that are not 3-part JWTs", async () => {
    const { verifyIdToken } = await import("../src/auth");
    const mockEnv = { FIREBASE_PROJECT_ID: "test-project", KV_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } } as any;
    await expect(verifyIdToken("not-a-jwt", mockEnv)).rejects.toThrow();
    await expect(verifyIdToken("a.b", mockEnv)).rejects.toThrow();
    await expect(verifyIdToken("a.b.c.d", mockEnv)).rejects.toThrow();
  });
});
