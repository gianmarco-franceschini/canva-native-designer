import { describe, expect, it } from "vitest";
import { findConflicts } from "./conflicts";

const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00Z`);
const busy = { "giulia@x.it": [{ start: at("09:00"), end: at("10:00") }] };

describe("findConflicts", () => {
  it("segnala la sovrapposizione parziale", () => {
    const r = findConflicts(busy, { start: at("09:30"), end: at("10:30") });
    expect(r).toEqual([{ email: "giulia@x.it", start: at("09:00"), end: at("10:00") }]);
  });

  it("intervalli adiacenti non sono conflitto", () => {
    expect(findConflicts(busy, { start: at("10:00"), end: at("11:00") })).toEqual([]);
    expect(findConflicts(busy, { start: at("08:00"), end: at("09:00") })).toEqual([]);
  });

  it("ordina per inizio e poi per email", () => {
    const r = findConflicts(
      {
        "z@x.it": [{ start: at("09:00"), end: at("10:00") }],
        "a@x.it": [{ start: at("09:00"), end: at("10:00") }, { start: at("08:00"), end: at("09:30") }],
      },
      { start: at("08:00"), end: at("11:00") },
    );
    expect(r.map((c) => [c.email, c.start.toISOString()])).toEqual([
      ["a@x.it", at("08:00").toISOString()],
      ["a@x.it", at("09:00").toISOString()],
      ["z@x.it", at("09:00").toISOString()],
    ]);
  });
});
