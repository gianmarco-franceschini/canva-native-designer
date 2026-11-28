import { describe, expect, it } from "vitest";
import { resolveAttendees } from "./people";

const colleagues = [
  { email: "giulia@d.it", fullName: "Giulia Bianchi" },
  { email: "marco@d.it", fullName: "Marco Rossi" },
  { email: "anna@d.it", fullName: "Anna Verdi" },
];

describe("resolveAttendees", () => {
  it("risolve email e nomi, toglie duplicati e richiedente, esterni in unknown", () => {
    const r = resolveAttendees(
      ["giulia", "Giulia Bianchi", "marco@d.it", "anna@d.it", "x@gmail.com"],
      "anna@d.it",
      colleagues,
    );
    expect(r).toEqual({
      emails: ["giulia@d.it", "marco@d.it"],
      unknown: ["x@gmail.com"],
      ambiguous: [],
    });
  });

  it("due Marco con lo stesso nome di battesimo → ambiguous", () => {
    const two = [...colleagues, { email: "marco.neri@d.it", fullName: "Marco Neri" }];
    const r = resolveAttendees(["marco"], "anna@d.it", two);
    expect(r.emails).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([{ input: "marco", options: ["marco@d.it", "marco.neri@d.it"] }]);
  });

  it("il nome intero vince sull'ambiguità del nome di battesimo", () => {
    const two = [...colleagues, { email: "marco.neri@d.it", fullName: "Marco Neri" }];
    expect(resolveAttendees(["marco neri"], "anna@d.it", two).emails).toEqual(["marco.neri@d.it"]);
  });

  it("confronto case-insensitive e trim sulle email; email non attive o nomi ignoti in unknown", () => {
    const r = resolveAttendees(["  GIULIA@D.IT ", "Paolo", "ex@d.it", ""], "ANNA@d.it", colleagues);
    expect(r).toEqual({ emails: ["giulia@d.it"], unknown: ["Paolo", "ex@d.it"], ambiguous: [] });
  });

  it("il richiedente indicato per nome viene rimosso senza finire in unknown", () => {
    expect(resolveAttendees(["Anna"], "anna@d.it", colleagues)).toEqual({
      emails: [],
      unknown: [],
      ambiguous: [],
    });
  });
});
