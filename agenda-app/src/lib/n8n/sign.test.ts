import { describe, expect, it } from "vitest";
import { signRequest, verifyRequest } from "./sign";

const secret = "s3cret";
const body = '{"a":1}';
const ts = 1_700_000_000_000;

describe("sign/verify", () => {
  it("accepts a correct signature", () => {
    const sig = signRequest(body, secret, ts);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRequest(body, secret, ts, sig, ts + 1000)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const sig = signRequest(body, secret, ts);
    expect(verifyRequest('{"a":2}', secret, ts, sig, ts)).toBe(false);
  });
  it("rejects a wrong secret", () => {
    const sig = signRequest(body, "other", ts);
    expect(verifyRequest(body, secret, ts, sig, ts)).toBe(false);
  });
  it("rejects timestamps older than 5 minutes", () => {
    const sig = signRequest(body, secret, ts);
    expect(verifyRequest(body, secret, ts, sig, ts + 300_000)).toBe(true);
    expect(verifyRequest(body, secret, ts, sig, ts + 300_001)).toBe(false);
  });
  it("rejects timestamps more than 5 minutes in the future", () => {
    const sig = signRequest(body, secret, ts);
    expect(verifyRequest(body, secret, ts, sig, ts - 300_000)).toBe(true);
    expect(verifyRequest(body, secret, ts, sig, ts - 300_001)).toBe(false);
  });
  it("returns false (no throw) for malformed signatures", () => {
    for (const bad of ["", "abc", "zz".repeat(32), "a".repeat(63), "a".repeat(65)]) {
      expect(verifyRequest(body, secret, ts, bad, ts)).toBe(false);
    }
  });
});
