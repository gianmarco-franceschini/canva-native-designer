import { describe, expect, it } from "vitest";
import { isItalianHoliday } from "./holidays";

// Mezzogiorno UTC = 12:00/13:00 a Roma, sempre nello stesso giorno di calendario.
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("isItalianHoliday", () => {
  it.each([
    "2026-01-01", "2026-01-06", "2026-04-25", "2026-05-01", "2026-06-02",
    "2026-08-15", "2026-11-01", "2026-12-08", "2026-12-25", "2026-12-26",
  ])("%s è festivo", (d) => expect(isItalianHoliday(noon(d))).toBe(true));

  it("Pasquetta 2027 (29/03/2027) è festiva", () => {
    expect(isItalianHoliday(noon("2027-03-29"))).toBe(true);
  });

  it("Pasquetta 2026 (06/04/2026) è festiva", () => {
    expect(isItalianHoliday(noon("2026-04-06"))).toBe(true);
  });

  it("Pasqua stessa (domenica) non è tra le festività calcolate", () => {
    expect(isItalianHoliday(noon("2027-03-28"))).toBe(false);
  });

  it("26/11/2026 non è festivo", () => {
    expect(isItalianHoliday(noon("2026-11-26"))).toBe(false);
  });

  it("valuta il giorno in Europe/Rome, non in UTC", () => {
    // 31/12 23:30Z = 01/01 00:30 a Roma
    expect(isItalianHoliday(new Date("2026-12-31T23:30:00Z"))).toBe(true);
    // 01/01 23:30Z = 02/01 00:30 a Roma
    expect(isItalianHoliday(new Date("2026-01-01T23:30:00Z"))).toBe(false);
  });
});
