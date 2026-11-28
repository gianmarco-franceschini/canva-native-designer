import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { EventRequest, Repo } from "@/lib/db/repo";
import { N8nError, type N8nClient } from "@/lib/n8n/client";
import { MSG_CALENDAR_ERROR, MSG_TIMEOUT, type Deps, type User } from "@/lib/requests/service";
import { DEFAULT_WORK_HOURS } from "@/lib/scheduling/types";
import { buildTools } from "./tools";

const user: User = { id: "u1", email: "anna@example.com", fullName: "Anna Rossi" };
const colleagues = [
  { email: "anna@example.com", fullName: "Anna Rossi" },
  { email: "giulia@example.com", fullName: "Giulia Bianchi" },
  { email: "marco@example.com", fullName: "Marco Verdi" },
  { email: "marco.neri@example.com", fullName: "Marco Neri" },
];

function fakeDeps(freeBusy?: N8nClient["freeBusy"]) {
  const inserted: unknown[] = [];
  const repo: Repo = {
    listColleagues: vi.fn(async () => colleagues),
    getSettings: vi.fn(async () => ({ workHours: DEFAULT_WORK_HOURS, closures: [] })),
    insertRequest: vi.fn(async (r) => {
      inserted.push(r);
      return {
        ...r,
        id: "req-1",
        status: "pending",
        googleEventId: null,
        googleEventLink: null,
        createdAt: new Date(),
        confirmedAt: null,
        error: null,
      } satisfies EventRequest;
    }),
    getRequest: vi.fn(),
    transitionRequest: vi.fn(),
    createConversation: vi.fn(),
    appendMessage: vi.fn(),
    countUserMessagesSince: vi.fn(),
    audit: vi.fn(async () => {}),
  };
  const n8n: N8nClient = {
    freeBusy: vi.fn(
      freeBusy ??
        (async (emails: string[]) => ({
          busy: Object.fromEntries(emails.map((e) => [e, []])),
          unreadable: [],
        })),
    ),
    createEvent: vi.fn(),
    cancelEvent: vi.fn(),
  };
  const deps: Deps = { repo, n8n, now: () => new Date("2026-11-26T08:00:00Z") };
  return { deps, repo, n8n, inserted };
}

const opts = { toolCallId: "t1", messages: [] };
type AnyTool = { inputSchema: unknown; execute?: (input: never, o: typeof opts) => unknown };
const schemaOf = (t: AnyTool) => t.inputSchema as z.ZodType;
const run = async (t: AnyTool, input: unknown) =>
  (await (t.execute as (i: unknown, o: typeof opts) => Promise<unknown>)(input, opts)) as Record<
    string,
    unknown
  >;

const fourteen = Array.from({ length: 14 }, (_, i) => `p${i}@example.com`);
const fifteen = [...fourteen, "p14@example.com"];

describe("buildTools", () => {
  it("espone esattamente i 4 strumenti, nessuno che crea eventi", () => {
    const tools = buildTools(fakeDeps().deps, user);
    expect(Object.keys(tools).sort()).toEqual(
      ["check_availability", "find_free_slots", "list_colleagues", "propose_event"].sort(),
    );
  });

  describe("validazione degli input", () => {
    const tools = buildTools(fakeDeps().deps, user);
    const slots = schemaOf(tools.find_free_slots);
    const base = {
      attendees: ["Giulia"],
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T18:00:00+01:00",
    };

    it.each([0, 14, 481, 30.5])("find_free_slots: durata %s → errore", (d) => {
      expect(slots.safeParse({ ...base, durationMinutes: d }).success).toBe(false);
    });

    it.each([15, 60, 480])("find_free_slots: durata %s → valida", (d) => {
      expect(slots.safeParse({ ...base, durationMinutes: d }).success).toBe(true);
    });

    it("date senza offset → errore", () => {
      expect(
        slots.safeParse({ ...base, durationMinutes: 60, from: "2026-11-27T09:00:00" }).success,
      ).toBe(false);
    });

    it.each(["check_availability", "find_free_slots", "propose_event"] as const)(
      "%s: massimo 14 partecipanti (15 con il richiedente)",
      (name) => {
        const s = schemaOf(tools[name]);
        const input = {
          ...base,
          durationMinutes: 60,
          title: "Riunione",
          start: "2026-11-27T10:00:00+01:00",
          end: "2026-11-27T11:00:00+01:00",
        };
        expect(s.safeParse({ ...input, attendees: fourteen }).success).toBe(true);
        expect(s.safeParse({ ...input, attendees: fifteen }).success).toBe(false);
      },
    );

    it("propose_event: titolo vuoto o senza partecipanti → errore", () => {
      const s = schemaOf(tools.propose_event);
      const ok = {
        title: "Budget",
        start: "2026-11-27T10:00:00+01:00",
        end: "2026-11-27T11:00:00+01:00",
        attendees: ["Giulia"],
      };
      expect(s.safeParse(ok).success).toBe(true);
      expect(s.safeParse({ ...ok, title: "" }).success).toBe(false);
      expect(s.safeParse({ ...ok, attendees: [] }).success).toBe(false);
    });
  });

  it("list_colleagues: solo nome ed email", async () => {
    const tools = buildTools(fakeDeps().deps, user);
    const out = await run(tools.list_colleagues, {});
    expect(out).toEqual({
      colleagues: colleagues.map((c) => ({ name: c.fullName, email: c.email })),
    });
  });

  it("check_availability: occupato in ora di Roma, nessun titolo", async () => {
    const { deps } = fakeDeps(async () => ({
      busy: {
        "anna@example.com": [],
        "giulia@example.com": [
          { start: new Date("2026-11-27T09:00:00Z"), end: new Date("2026-11-27T10:00:00Z") },
        ],
      },
      unreadable: [],
    }));
    const out = await run(buildTools(deps, user).check_availability, {
      attendees: ["Giulia"],
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T13:00:00+01:00",
    });
    expect(out).toEqual({
      busy: {
        "anna@example.com": [],
        "giulia@example.com": [
          { start: "2026-11-27T10:00:00.000+01:00", end: "2026-11-27T11:00:00.000+01:00" },
        ],
      },
      unreadable: [],
    });
  });

  it("intervallo oltre 14 giorni o rovesciato → errore senza chiamare il calendario", async () => {
    const { deps, n8n } = fakeDeps();
    const tools = buildTools(deps, user);
    const long = await run(tools.check_availability, {
      attendees: ["Giulia"],
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-12-12T09:00:00+01:00",
    });
    const reversed = await run(tools.find_free_slots, {
      attendees: ["Giulia"],
      durationMinutes: 30,
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T08:00:00+01:00",
    });
    expect(long.error).toMatch(/14 giorni/);
    expect(reversed.error).toMatch(/dopo l'inizio/);
    expect(n8n.freeBusy).not.toHaveBeenCalled();
  });

  it("nome ambiguo o sconosciuto → errore strutturato con le opzioni", async () => {
    const { deps, n8n } = fakeDeps();
    const out = await run(buildTools(deps, user).check_availability, {
      attendees: ["Marco", "Pippo"],
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T13:00:00+01:00",
    });
    expect(out.error).toEqual(expect.any(String));
    expect(out.unknown).toEqual(["Pippo"]);
    expect(out.ambiguous).toEqual([
      { input: "Marco", options: ["marco@example.com", "marco.neri@example.com"] },
    ]);
    expect(n8n.freeBusy).not.toHaveBeenCalled();
  });

  it("find_free_slots: slot in ora di Roma", async () => {
    const { deps } = fakeDeps();
    const out = await run(buildTools(deps, user).find_free_slots, {
      attendees: ["Giulia"],
      durationMinutes: 60,
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T11:00:00+01:00",
    });
    expect(out.slots).toEqual([
      { start: "2026-11-27T09:00:00.000+01:00", end: "2026-11-27T10:00:00.000+01:00" },
      { start: "2026-11-27T10:00:00.000+01:00", end: "2026-11-27T11:00:00.000+01:00" },
    ]);
  });

  describe("errori del calendario → messaggio italiano, non eccezione", () => {
    const input = {
      attendees: ["Giulia"],
      durationMinutes: 60,
      title: "Budget",
      from: "2026-11-27T09:00:00+01:00",
      to: "2026-11-27T13:00:00+01:00",
      start: "2026-11-27T10:00:00+01:00",
      end: "2026-11-27T11:00:00+01:00",
    };
    it.each([
      ["timeout", MSG_TIMEOUT],
      ["http", MSG_CALENDAR_ERROR],
      ["invalid_response", MSG_CALENDAR_ERROR],
    ] as const)("%s", async (kind, msg) => {
      const { deps } = fakeDeps(async () => {
        throw new N8nError(kind, "dettaglio interno");
      });
      const tools = buildTools(deps, user);
      for (const name of ["check_availability", "find_free_slots", "propose_event"] as const) {
        await expect(run(tools[name], input)).resolves.toEqual({ error: msg });
      }
    });

    it("errori non del calendario restano eccezioni", async () => {
      const { deps } = fakeDeps(async () => {
        throw new Error("db giù");
      });
      await expect(run(buildTools(deps, user).check_availability, input)).rejects.toThrow("db giù");
    });
  });

  describe("propose_event", () => {
    const input = {
      title: "Riunione budget",
      start: "2026-11-27T10:00:00+01:00",
      end: "2026-11-27T11:00:00+01:00",
      attendees: ["Giulia", "Marco Verdi"],
    };

    it("senza conflitti → proposta con id, partecipanti e nessun conflitto", async () => {
      const { deps, inserted } = fakeDeps();
      const out = await run(buildTools(deps, user).propose_event, input);
      expect(out).toEqual({
        requestId: "req-1",
        title: "Riunione budget",
        start: "2026-11-27T10:00:00.000+01:00",
        end: "2026-11-27T11:00:00.000+01:00",
        attendees: [
          { email: "giulia@example.com", name: "Giulia Bianchi" },
          { email: "marco@example.com", name: "Marco Verdi" },
        ],
        conflicts: [],
        unreadable: [],
      });
      expect(inserted).toHaveLength(1);
    });

    it("con conflitti e calendari illeggibili → solo email e orari", async () => {
      const { deps } = fakeDeps(async () => ({
        busy: {
          "anna@example.com": [],
          "giulia@example.com": [
            { start: new Date("2026-11-27T09:30:00Z"), end: new Date("2026-11-27T10:30:00Z") },
          ],
          "marco@example.com": [
            { start: new Date("2026-11-27T09:00:00Z"), end: new Date("2026-11-27T10:00:00Z") },
          ],
        },
        unreadable: ["marco@example.com"],
      }));
      const out = await run(buildTools(deps, user).propose_event, input);
      expect(out.conflicts).toEqual([
        {
          email: "marco@example.com",
          name: "Marco Verdi",
          start: "2026-11-27T10:00:00.000+01:00",
          end: "2026-11-27T11:00:00.000+01:00",
        },
        {
          email: "giulia@example.com",
          name: "Giulia Bianchi",
          start: "2026-11-27T10:30:00.000+01:00",
          end: "2026-11-27T11:30:00.000+01:00",
        },
      ]);
      expect(out.unreadable).toEqual(["marco@example.com"]);
    });

    it("input non valido per il servizio → errore", async () => {
      const { deps, inserted } = fakeDeps();
      const out = await run(buildTools(deps, user).propose_event, {
        ...input,
        start: "2026-11-25T10:00:00+01:00",
        end: "2026-11-25T11:00:00+01:00",
      });
      expect(out).toEqual({ error: "L'inizio è già passato." });
      expect(inserted).toHaveLength(0);
    });

    it("partecipante esterno → errore senza creare la richiesta", async () => {
      const { deps, inserted } = fakeDeps();
      const out = await run(buildTools(deps, user).propose_event, {
        ...input,
        attendees: ["esterno@gmail.com"],
      });
      expect(out.error).toEqual(expect.any(String));
      expect(out.unknown).toEqual(["esterno@gmail.com"]);
      expect(inserted).toHaveLength(0);
    });
  });
});
