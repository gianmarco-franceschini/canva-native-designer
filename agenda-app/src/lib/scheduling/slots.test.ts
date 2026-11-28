import { describe, expect, it } from "vitest";
import { findFreeSlots } from "./slots";
import { DEFAULT_WORK_HOURS, type Interval } from "./types";

const d = (iso: string) => new Date(iso);
const iv = (s: string, e: string): Interval => ({ start: d(s), end: d(e) });
const base = { workHours: DEFAULT_WORK_HOURS, closures: [] as string[], now: d("2026-01-01T00:00:00Z"), durationMinutes: 60 };

describe("findFreeSlots", () => {
  it("salta l'occupato e restituisce slot consecutivi (ora di Roma, inverno = UTC+1)", () => {
    const r = findFreeSlots({
      ...base,
      busy: { "giulia@x.it": [iv("2026-11-26T09:00:00Z", "2026-11-26T10:00:00Z")] }, // 10-11 Roma
      from: d("2026-11-26T08:00:00Z"), // 09:00 Roma
      to: d("2026-11-26T12:00:00Z"), // 13:00 Roma
    });
    expect(r).toEqual([
      iv("2026-11-26T08:00:00Z", "2026-11-26T09:00:00Z"),
      iv("2026-11-26T10:00:00Z", "2026-11-26T11:00:00Z"),
      iv("2026-11-26T11:00:00Z", "2026-11-26T12:00:00Z"),
    ]);
  });

  it("nessuno slot attraversa la pausa 13-14", () => {
    const r = findFreeSlots({
      ...base, busy: {}, limit: 20,
      from: d("2026-11-26T11:00:00Z"), // 12:00 Roma
      to: d("2026-11-26T14:00:00Z"), // 15:00 Roma
    });
    expect(r).toEqual([
      iv("2026-11-26T11:00:00Z", "2026-11-26T12:00:00Z"), // 12-13
      iv("2026-11-26T13:00:00Z", "2026-11-26T14:00:00Z"), // 14-15
    ]);
  });

  it("weekend, festivi e chiusure danno []", () => {
    const common = { ...base, busy: {} };
    expect(findFreeSlots({ ...common, from: d("2026-11-28T00:00:00Z"), to: d("2026-11-29T23:00:00Z") })).toEqual([]); // sab-dom
    expect(findFreeSlots({ ...common, from: d("2026-12-24T23:00:00Z"), to: d("2026-12-25T23:00:00Z") })).toEqual([]); // Natale
    expect(findFreeSlots({ ...common, closures: ["2026-11-26"], from: d("2026-11-25T23:00:00Z"), to: d("2026-11-26T23:00:00Z") })).toEqual([]);
  });

  it("Pasquetta 29/03/2027 è festiva: []", () => {
    expect(findFreeSlots({ ...base, busy: {}, from: d("2027-03-28T23:00:00Z"), to: d("2027-03-29T22:00:00Z") })).toEqual([]);
  });

  it("esclude slot che iniziano prima di now", () => {
    const r = findFreeSlots({
      ...base, busy: {},
      now: d("2026-11-26T09:15:00Z"), // 10:15 Roma
      from: d("2026-11-26T08:00:00Z"), to: d("2026-11-26T12:00:00Z"),
    });
    expect(r[0]).toEqual(iv("2026-11-26T09:30:00Z", "2026-11-26T10:30:00Z"));
  });

  it("rispetta limit e step", () => {
    const r = findFreeSlots({
      ...base, busy: {}, limit: 2, durationMinutes: 30, stepMinutes: 15,
      from: d("2026-11-26T08:00:00Z"), to: d("2026-11-26T12:00:00Z"),
    });
    expect(r).toEqual([
      iv("2026-11-26T08:00:00Z", "2026-11-26T08:30:00Z"),
      iv("2026-11-26T08:30:00Z", "2026-11-26T09:00:00Z"),
    ]);
  });

  it("ora legale: lun 26/10/2026 primo slot 09:00 Roma (08:00Z)", () => {
    const r = findFreeSlots({ ...base, busy: {}, from: d("2026-10-25T23:00:00Z"), to: d("2026-10-26T23:00:00Z") });
    expect(r[0].start).toEqual(d("2026-10-26T08:00:00Z"));
  });

  it("dopo il cambio ora (mar 30/03/2027) primo slot 09:00 Roma (07:00Z)", () => {
    const r = findFreeSlots({ ...base, busy: {}, from: d("2027-03-29T22:00:00Z"), to: d("2027-03-30T22:00:00Z") });
    expect(r[0].start).toEqual(d("2027-03-30T07:00:00Z"));
  });

  it("lo slot deve stare dentro [from, to]", () => {
    const r = findFreeSlots({
      ...base, busy: {}, limit: 10,
      from: d("2026-11-26T08:30:00Z"), to: d("2026-11-26T09:30:00Z"),
    });
    expect(r).toEqual([iv("2026-11-26T08:30:00Z", "2026-11-26T09:30:00Z")]);
  });

  it("scorre i giorni successivi", () => {
    const r = findFreeSlots({
      ...base, busy: {}, limit: 1,
      from: d("2026-11-27T12:00:00Z"), // ven 13:00 Roma
      to: d("2026-12-01T12:00:00Z"),
    });
    expect(r).toEqual([iv("2026-11-27T13:00:00Z", "2026-11-27T14:00:00Z")]); // ven 14-15
    const r2 = findFreeSlots({
      ...base, busy: {}, limit: 1,
      from: d("2026-11-27T17:00:00Z"), // ven 18:00 Roma
      to: d("2026-12-01T12:00:00Z"),
    });
    expect(r2).toEqual([iv("2026-11-30T08:00:00Z", "2026-11-30T09:00:00Z")]); // lun 09-10
  });
});
