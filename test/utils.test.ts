import { describe, it, expect } from "vitest";
import { json, errorResponse, corsResponse, extractBearerToken, timingSafeEqual, isNonEmptyString, isPositiveNumber, isNonNegativeInt, rateLimit, HttpError } from "../src/utils";

describe("json", () => {
  it("should create a JSON response with CORS headers", () => {
    const resp = json({ ok: true, data: { test: 1 } });
    expect(resp.status).toBe(200); expect(resp.headers.get("Content-Type")).toBe("application/json"); expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("corsResponse", () => {
  it("should create a 204 response with CORS headers", () => {
    const resp = corsResponse();
    expect(resp.status).toBe(204); expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("extractBearerToken", () => {
  it("should extract token from Bearer header", () => {
    const mockRequest = { headers: { get: (name: string) => name === "Authorization" ? "Bearer abc123" : null } } as unknown as Request;
    expect(extractBearerToken(mockRequest)).toBe("abc123");
  });
  it("should return null for missing header", () => {
    const mockRequest = { headers: { get: () => null } } as unknown as Request;
    expect(extractBearerToken(mockRequest)).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("should return true for equal strings", () => { expect(timingSafeEqual("abc", "abc")).toBe(true); });
  it("should return false for different strings", () => { expect(timingSafeEqual("abc", "abd")).toBe(false); });
  it("should return false for different lengths", () => { expect(timingSafeEqual("abc", "abcd")).toBe(false); });
});

describe("type guards", () => {
  it("isNonEmptyString", () => { expect(isNonEmptyString("hello")).toBe(true); expect(isNonEmptyString("")).toBe(false); expect(isNonEmptyString(123)).toBe(false); });
  it("isPositiveNumber", () => { expect(isPositiveNumber(1)).toBe(true); expect(isPositiveNumber(0)).toBe(false); expect(isPositiveNumber(-1)).toBe(false); });
  it("isNonNegativeInt", () => { expect(isNonNegativeInt(0)).toBe(true); expect(isNonNegativeInt(-1)).toBe(false); expect(isNonNegativeInt(1.5)).toBe(false); });
});

describe("rateLimit", () => {
  it("should allow requests within limit", () => { expect(rateLimit("test-key-1", 5, 60000)).toBe(true); });
  it("should block requests exceeding limit", () => {
    const key = "test-key-block";
    for (let i = 0; i < 3; i++) rateLimit(key, 3, 60000);
    expect(rateLimit(key, 3, 60000)).toBe(false);
  });
});

describe("HttpError", () => {
  it("should create an HttpError with status, code, and message", () => {
    const err = new HttpError(404, "NOT_FOUND", "Resource not found");
    expect(err.status).toBe(404); expect(err.code).toBe("NOT_FOUND"); expect(err.name).toBe("HttpError");
  });
});
