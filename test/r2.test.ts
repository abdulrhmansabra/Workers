import { describe, it, expect } from "vitest";
import { validateFileMetadata, generateObjectKey, generateOutputKey } from "../src/r2";
import { HttpError } from "../src/utils";

describe("validateFileMetadata", () => {
  it("should accept valid image types", () => { expect(() => validateFileMetadata("image/png", 1024)).not.toThrow(); expect(() => validateFileMetadata("image/jpeg", 1024)).not.toThrow(); });
  it("should accept valid video types", () => { expect(() => validateFileMetadata("video/mp4", 1024)).not.toThrow(); });
  it("should reject invalid MIME types", () => { expect(() => validateFileMetadata("application/pdf", 1024)).toThrow(HttpError); });
  it("should reject zero-size files", () => { expect(() => validateFileMetadata("image/png", 0)).toThrow(HttpError); });
  it("should reject files exceeding max size", () => { expect(() => validateFileMetadata("image/png", 100 * 1024 * 1024, 50)).toThrow(HttpError); });
});

describe("generateObjectKey", () => {
  it("should generate a key with uid and extension", () => {
    const key = generateObjectKey("user123", "image/png");
    expect(key).toMatch(/^uploads\/user123\/[0-9a-f-]+\.png$/);
  });
});

describe("generateOutputKey", () => {
  it("should generate a key with uid and jobId", () => {
    const key = generateOutputKey("user123", "job456", "mp4");
    expect(key).toBe("outputs/user123/job456.mp4");
  });
});
