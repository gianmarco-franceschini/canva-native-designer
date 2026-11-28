import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { signRequest, verifyRequest } from "./sign";

// verify-signature.js è il codice incollato nel Code node "Verifica firma" dei workflow n8n.
const require = createRequire(import.meta.url);
const { verifyAgendaSignature } = require("../../../n8n/verify-signature.js") as {
  verifyAgendaSignature: (
    rawBody: string,
    secret: string,
    timestampMs: number,
    signature: string,
    nowMs: number,
  ) => boolean;
};

const secret = "s3cret";
const body = '{"emails":["a@x.it"],"timeMin":"2026-12-01T08:00:00.000Z"}';
const ts = 1_700_000_000_000;
const sig = signRequest(body, secret, ts);

type Case = [name: string, rawBody: string, sec: string, t: number, s: string, now: number, expected: boolean];

const cases: Case[] = [
  ["firma valida", body, secret, ts, sig, ts + 1000, true],
  ["firma valida in maiuscolo", body, secret, ts, sig.toUpperCase(), ts, true],
  ["body alterato", body.replace("a@x", "b@x"), secret, ts, sig, ts, false],
  ["secret sbagliato", body, "altro", ts, sig, ts, false],
  ["timestamp alterato", body, secret, ts + 1, sig, ts, false],
  ["vecchia di 5 minuti esatti", body, secret, ts, sig, ts + 300_000, true],
  ["vecchia di oltre 5 minuti", body, secret, ts, sig, ts + 300_001, false],
  ["futura di 5 minuti esatti", body, secret, ts, sig, ts - 300_000, true],
  ["futura di oltre 5 minuti", body, secret, ts, sig, ts - 300_001, false],
  ["timestamp NaN", body, secret, Number.NaN, sig, ts, false],
  ["firma vuota", body, secret, ts, "", ts, false],
  ["firma troncata", body, secret, ts, sig.slice(0, 62), ts, false],
  ["firma non esadecimale", body, secret, ts, "z".repeat(64), ts, false],
];

describe("n8n/verify-signature.js", () => {
  it.each(cases)("%s", (_name, rawBody, sec, t, s, now, expected) => {
    expect(verifyAgendaSignature(rawBody, sec, t, s, now)).toBe(expected);
    // Stesso esito di verifyRequest (sign.ts) su ogni caso.
    expect(verifyAgendaSignature(rawBody, sec, t, s, now)).toBe(verifyRequest(rawBody, sec, t, s, now));
  });

  it("non lancia con una firma non stringa", () => {
    expect(verifyAgendaSignature(body, secret, ts, undefined as unknown as string, ts)).toBe(false);
  });
});
