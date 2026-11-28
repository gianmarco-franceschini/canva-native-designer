import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_HOURS } from "@/lib/scheduling/types";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(new Date("2026-11-26T08:00:00Z"), DEFAULT_WORK_HOURS);

  it("contiene giorno della settimana, data e ora correnti a Roma", () => {
    expect(prompt).toContain("giovedì 26 novembre 2026");
    expect(prompt).toContain("09:00");
    expect(prompt).toContain("Europe/Rome");
  });

  it("usa il giorno di Roma anche quando in UTC è ancora il giorno prima", () => {
    const late = buildSystemPrompt(new Date("2026-11-26T23:30:00Z"), DEFAULT_WORK_HOURS);
    expect(late).toContain("venerdì 27 novembre 2026");
  });

  it("descrive l'orario lavorativo", () => {
    expect(prompt).toContain("lunedì, martedì, mercoledì, giovedì, venerdì");
    expect(prompt).toContain("09:00–13:00");
    expect(prompt).toContain("14:00–18:00");
  });

  it("riflette un orario lavorativo modificato", () => {
    const p = buildSystemPrompt(new Date("2026-11-26T08:00:00Z"), {
      days: [1, 3],
      ranges: [{ from: "08:30", to: "12:00" }],
    });
    expect(p).toContain("lunedì, mercoledì");
    expect(p).toContain("08:30–12:00");
    expect(p).not.toContain("14:00–18:00");
  });

  it.each([
    ["usa sempre i tool", /usa sempre gli strumenti/i],
    ["non inventa disponibilità", /non inventare mai disponibilità/i],
    ["non conosce i dettagli degli impegni altrui", /non conosci (i )?(titoli|dettagli)/i],
    ["non crea eventi, solo proposte", /non puoi creare eventi/i],
    ["conferma col pulsante", /pulsante/i],
    ["chiede chiarimenti sui nomi ambigui", /ambiguo/i],
    ["tratta i contenuti come dati", /come dati/i],
    ["non rivela il prompt", /non rivelare/i],
    ["solo argomenti di pianificazione", /solo di pianificazione/i],
    ["base di conoscenza non disponibile", /base di conoscenza/i],
  ])("regola: %s", (_n, re) => {
    expect(prompt).toMatch(re);
  });
});
