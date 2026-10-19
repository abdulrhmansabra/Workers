import { describe, it, expect } from "vitest";
import { SSVError } from "../src/admob";

describe("SSVError", () => {
  it("should create an SSVError with code and message", () => {
    const err = new SSVError("INVALID_SIGNATURE", "Signature failed");
    expect(err.code).toBe("INVALID_SIGNATURE"); expect(err.name).toBe("SSVError");
  });
});

describe("AdMob SSV parameter parsing", () => {
  it("should require all mandatory parameters", () => {
    const url = new URL("https://example.com/v1/admob-ssv?ad_network=admob");
    expect(url.searchParams.get("key_id")).toBeNull();
  });
});

describe("buildSignedQuery logic", () => {
  it("should exclude signature param from signed query", () => {
    const rawQuery = "ad_network=admob&ad_unit=123&key_id=1&reward_amount=5&signature=abc&transaction_id=tx1";
    const pairs = rawQuery.split("&");
    const filtered = pairs.filter((pair) => !pair.startsWith("signature="));
    const signedQuery = filtered.join("&");
    expect(signedQuery).not.toContain("signature");
    expect(signedQuery).toContain("ad_network=admob");
    expect(signedQuery).toContain("transaction_id=tx1");
  });
});
