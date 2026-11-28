import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_MS = 5 * 60 * 1000;

/** hex(HMAC-SHA256(secret, timestamp + "." + rawBody)) */
export function signRequest(rawBody: string, secret: string, timestampMs: number): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`).digest("hex");
}

/** Stessa logica copiata nel Code node n8n. Non lancia mai: firma malformata => false. */
export function verifyRequest(
  rawBody: string,
  secret: string,
  timestampMs: number,
  signature: string,
  nowMs: number,
): boolean {
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_SKEW_MS) return false;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signRequest(rawBody, secret, timestampMs), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
