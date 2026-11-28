import { describe, expect, it, vi, type Mock } from "vitest";
import type { AuditEntry, EventRequest, Repo, RequestStatus } from "@/lib/db/repo";
import { N8nError, type N8nClient } from "@/lib/n8n/client";
import {
  cancelRequest,
  checkAvailability,
  confirmRequest,
  proposeEvent,
  suggestSlots,
  type Deps,
  type User,
} from "./service";

const NOW = new Date("2030-03-04T08:00:00Z"); // lunedì 09:00 a Roma
const user: User = { id: "u1", email: "anna@azienda.it", fullName: "Anna Rossi" };
const colleagues = [
  { email: "anna@azienda.it", fullName: "Anna Rossi" },
  { email: "giulia@azienda.it", fullName: "Giulia Bianchi" },
  { email: "marco@azienda.it", fullName: "Marco Verdi" },
  { email: "marco2@azienda.it", fullName: "Marco Neri" },
];
const start = new Date("2030-03-05T09:00:00Z");
const end = new Date("2030-03-05T10:00:00Z");

function fakeRepo() {
  const rows = new Map<string, EventRequest>();
  const audits: AuditEntry[] = [];
  let seq = 0;
  const repo: Repo = {
    listColleagues: async () => colleagues,
    getSettings: async () => ({
      workHours: {
        days: [1, 2, 3, 4, 5],
        ranges: [
          { from: "09:00", to: "13:00" },
          { from: "14:00", to: "18:00" },
        ],
      },
      closures: [],
    }),
    insertRequest: async (r) => {
      const row: EventRequest = {
        ...r,
        id: `req-${++seq}`,
        status: "pending",
        googleEventId: null,
        googleEventLink: null,
        createdAt: NOW,
        confirmedAt: null,
        error: null,
      };
      rows.set(row.id, row);
      return { ...row };
    },
    getRequest: async (id, userId) => {
      const row = rows.get(id);
      return row && row.userId === userId ? { ...row } : null;
    },
    // Check-and-set in un solo passo sincrono: emula l'UPDATE condizionale.
    transitionRequest(id, userId, from: RequestStatus, to: RequestStatus, patch = {}) {
      const row = rows.get(id);
      if (!row || row.userId !== userId || row.status !== from) return Promise.resolve(null);
      const next = { ...row, ...patch, status: to };
      rows.set(id, next);
      return Promise.resolve({ ...next });
    },
    createConversation: async () => {
      throw new Error("unused");
    },
    appendMessage: async () => {},
    countUserMessagesSince: async () => 0,
    audit: async (e) => {
      audits.push(e);
    },
  };
  return { repo, rows, audits };
}

function setup(overrides: Partial<N8nClient> = {}) {
  const { repo, rows, audits } = fakeRepo();
  const n8n: Record<keyof N8nClient, Mock> = {
    freeBusy: vi.fn(async (emails: string[]) => ({
      busy: Object.fromEntries(emails.map((e) => [e, []])),
      unreadable: [] as string[],
    })),
    createEvent: vi.fn(async () => ({
      status: "created" as const,
      eventId: "g1",
      htmlLink: "https://cal/g1",
    })),
    cancelEvent: vi.fn(async () => ({ status: "cancelled" as const })),
    ...(overrides as Partial<Record<keyof N8nClient, Mock>>),
  };
  const deps: Deps = { repo, n8n: n8n as unknown as N8nClient, now: () => NOW };
  return { deps, repo, rows, audits, n8n };
}

const proposal = { title: "Sync", start, end, attendees: ["Giulia"] };

async function proposed(s: ReturnType<typeof setup>) {
  const r = await proposeEvent(s.deps, user, proposal);
  if (r.status !== "proposed") throw new Error("expected proposed");
  return r.request;
}

describe("proposeEvent", () => {
  it("non crea l'evento e salva i conflitti di Giulia", async () => {
    const s = setup({
      freeBusy: vi.fn(async (emails: string[]) => ({
        busy: Object.fromEntries(
          emails.map((e) => [
            e,
            e === "giulia@azienda.it"
              ? [{ start: new Date("2030-03-05T09:30:00Z"), end: new Date("2030-03-05T11:00:00Z") }]
              : [],
          ]),
        ),
        unreadable: [],
      })),
    });
    const r = await proposeEvent(s.deps, user, proposal);
    expect(r.status).toBe("proposed");
    if (r.status !== "proposed") return;
    expect(s.n8n.createEvent).not.toHaveBeenCalled();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].email).toBe("giulia@azienda.it");
    expect(r.request.status).toBe("pending");
    expect(r.request.attendeeEmails).toEqual(["giulia@azienda.it"]);
    expect(r.request.conflictSnapshot).toEqual({
      conflicts: [
        {
          email: "giulia@azienda.it",
          start: "2030-03-05T09:30:00.000Z",
          end: "2030-03-05T11:00:00.000Z",
        },
      ],
      unreadable: [],
    });
    expect(s.n8n.freeBusy.mock.calls[0][0].sort()).toEqual(["anna@azienda.it", "giulia@azienda.it"]);
    expect(s.audits.map((a) => a.action)).toEqual(["event_proposed"]);
  });

  it("segnala partecipanti ignoti o ambigui senza chiamare n8n né salvare", async () => {
    const s = setup();
    const r = await proposeEvent(s.deps, user, { ...proposal, attendees: ["Marco", "Pippo"] });
    expect(r.status).toBe("invalid_attendees");
    if (r.status !== "invalid_attendees") return;
    expect(r.unknown).toEqual(["Pippo"]);
    expect(r.ambiguous).toHaveLength(1);
    expect(s.n8n.freeBusy).not.toHaveBeenCalled();
    expect(s.rows.size).toBe(0);
  });

  it.each([
    ["titolo vuoto", { title: "   " }],
    ["titolo lungo", { title: "x".repeat(201) }],
    ["fine prima dell'inizio", { end: new Date("2030-03-05T08:00:00Z") }],
    ["più di 8 ore", { end: new Date("2030-03-05T18:00:00Z") }],
    ["inizio nel passato", { start: new Date("2030-03-04T07:00:00Z"), end }],
    ["nessun partecipante", { attendees: [] }],
  ])("rifiuta input non valido: %s", async (_n, patch) => {
    const s = setup();
    const r = await proposeEvent(s.deps, user, { ...proposal, ...patch });
    expect(r.status).toBe("invalid_input");
    expect(s.n8n.freeBusy).not.toHaveBeenCalled();
    expect(s.rows.size).toBe(0);
  });
});

describe("checkAvailability / suggestSlots", () => {
  it("include sempre il richiedente", async () => {
    const s = setup();
    const r = await checkAvailability(s.deps, user, {
      attendees: ["giulia@azienda.it"],
      from: start,
      to: end,
    });
    expect(Object.keys(r.busy).sort()).toEqual(["anna@azienda.it", "giulia@azienda.it"]);
    expect(s.audits.map((a) => a.action)).toEqual(["availability_checked"]);
  });

  it("non chiama n8n se ci sono ignoti", async () => {
    const s = setup();
    const r = await checkAvailability(s.deps, user, { attendees: ["Pippo"], from: start, to: end });
    expect(r.unknown).toEqual(["Pippo"]);
    expect(s.n8n.freeBusy).not.toHaveBeenCalled();
  });

  it("propaga N8nError", async () => {
    const s = setup({ freeBusy: vi.fn().mockRejectedValue(new N8nError("timeout", "x")) });
    await expect(
      checkAvailability(s.deps, user, { attendees: ["Giulia"], from: start, to: end }),
    ).rejects.toBeInstanceOf(N8nError);
  });

  it("suggerisce slot liberi evitando gli occupati", async () => {
    const s = setup({
      freeBusy: vi.fn(async (emails: string[]) => ({
        busy: Object.fromEntries(
          emails.map((e) => [
            e,
            [{ start: new Date("2030-03-05T08:00:00Z"), end: new Date("2030-03-05T09:00:00Z") }],
          ]),
        ),
        unreadable: [],
      })),
    });
    const r = await suggestSlots(s.deps, user, {
      attendees: ["Giulia"],
      durationMinutes: 60,
      from: new Date("2030-03-05T08:00:00Z"),
      to: new Date("2030-03-05T17:00:00Z"),
    });
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots[0].start.toISOString()).toBe("2030-03-05T09:00:00.000Z");
  });
});

describe("confirmRequest", () => {
  it("conferma, salva i dati Google e scrive l'audit", async () => {
    const s = setup();
    const req = await proposed(s);
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r).toEqual({ status: "confirmed", htmlLink: "https://cal/g1" });
    const row = s.rows.get(req.id)!;
    expect(row.status).toBe("confirmed");
    expect(row.googleEventId).toBe("g1");
    expect(s.n8n.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: req.id,
        organizerEmail: "anna@azienda.it",
        attendeeEmails: ["giulia@azienda.it"],
        allowConflict: false,
      }),
    );
    expect(s.audits.at(-1)?.action).toBe("event_confirmed");
  });

  it("richiesta di un altro utente: errore e nessuna chiamata n8n", async () => {
    const s = setup();
    const req = await proposed(s);
    const r = await confirmRequest(s.deps, { ...user, id: "u2" }, req.id, false);
    expect(r.status).toBe("error");
    expect(s.n8n.createEvent).not.toHaveBeenCalled();
  });

  it("doppio clic: createEvent una sola volta", async () => {
    const s = setup();
    const req = await proposed(s);
    const [a, b] = await Promise.all([
      confirmRequest(s.deps, user, req.id, false),
      confirmRequest(s.deps, user, req.id, false),
    ]);
    expect(s.n8n.createEvent).toHaveBeenCalledTimes(1);
    const results = [a, b];
    expect(results.filter((x) => x.status === "confirmed")).toHaveLength(1);
    const err = results.find((x) => x.status === "error");
    expect(err).toMatchObject({ status: "error", message: expect.stringContaining("già in conferma") });
  });

  it("orario già passato: errore, nessuna chiamata, stato invariato", async () => {
    const s = setup();
    const req = await proposed(s);
    const late: Deps = { ...s.deps, now: () => new Date("2030-03-05T09:30:00Z") };
    const r = await confirmRequest(late, user, req.id, false);
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("orario già passato") });
    expect(s.n8n.createEvent).not.toHaveBeenCalled();
    expect(s.rows.get(req.id)!.status).toBe("pending");
  });

  it("conflitto da n8n: torna pending e restituisce i conflitti", async () => {
    const s = setup({
      createEvent: vi.fn(async () => ({
        status: "conflict" as const,
        busy: {
          "giulia@azienda.it": [
            { start: new Date("2030-03-05T09:00:00Z"), end: new Date("2030-03-05T10:00:00Z") },
          ],
        },
      })),
    });
    const req = await proposed(s);
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.conflicts).toHaveLength(1);
    expect(s.rows.get(req.id)!.status).toBe("pending");
  });

  it("allowConflict=true passa a n8n e l'audit lo riporta", async () => {
    const s = setup();
    const req = await proposed(s);
    await confirmRequest(s.deps, user, req.id, true);
    expect(s.n8n.createEvent).toHaveBeenCalledWith(expect.objectContaining({ allowConflict: true }));
    expect(s.audits.at(-1)?.action).toBe("event_confirmed_with_conflict");
  });

  it("timeout n8n: stato failed con messaggio italiano", async () => {
    const s = setup({ createEvent: vi.fn().mockRejectedValue(new N8nError("timeout", "t")) });
    const req = await proposed(s);
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r).toEqual({ status: "error", message: "Il calendario non risponde, riprova tra poco." });
    const row = s.rows.get(req.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Il calendario non risponde, riprova tra poco.");
    expect(s.audits.at(-1)?.action).toBe("event_failed");
  });

  it("altri errori n8n: messaggio generico", async () => {
    const s = setup({ createEvent: vi.fn().mockRejectedValue(new N8nError("http", "500")) });
    const req = await proposed(s);
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r).toEqual({ status: "error", message: "Errore del calendario, riprova più tardi." });
    expect(s.rows.get(req.id)!.status).toBe("failed");
  });
});

describe("confirmRequest persistenza e casi limite", () => {
  it("persistenza che lancia dopo createEvent: resta confirmed, nessun event_failed", async () => {
    const s = setup();
    const req = await proposed(s);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = s.repo.transitionRequest.bind(s.repo);
    s.repo.transitionRequest = (id, uid, from, to, patch) =>
      to === "confirmed" ? Promise.reject(new Error("db down")) : orig(id, uid, from, to, patch);
    s.repo.audit = async (e) => {
      if (e.action.startsWith("event_confirmed")) throw new Error("audit down");
      s.audits.push(e);
    };
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r).toEqual({ status: "confirmed", htmlLink: "https://cal/g1" });
    expect(s.audits.some((a) => a.action === "event_failed")).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("richiesta già confermata: errore 'già confermata'", async () => {
    const s = setup();
    const req = await proposed(s);
    await confirmRequest(s.deps, user, req.id, false);
    const r = await confirmRequest(s.deps, user, req.id, false);
    expect(r).toMatchObject({ status: "error", message: expect.stringContaining("già confermata") });
    expect(s.n8n.createEvent).toHaveBeenCalledTimes(1);
  });

  it("conflitto n8n: audit event_conflict_on_confirm", async () => {
    const s = setup({
      createEvent: vi.fn(async () => ({ status: "conflict" as const, busy: {} })),
    });
    const req = await proposed(s);
    await confirmRequest(s.deps, user, req.id, false);
    expect(s.audits.at(-1)?.action).toBe("event_conflict_on_confirm");
  });

  it("suggestSlots con ignoti: nessuna chiamata n8n", async () => {
    const s = setup();
    const r = await suggestSlots(s.deps, user, {
      attendees: ["Pippo"],
      durationMinutes: 30,
      from: start,
      to: end,
    });
    expect(r.unknown).toEqual(["Pippo"]);
    expect(r.slots).toEqual([]);
    expect(s.n8n.freeBusy).not.toHaveBeenCalled();
  });
});

describe("cancelRequest", () => {
  it("pending: annulla senza n8n", async () => {
    const s = setup();
    const req = await proposed(s);
    expect(await cancelRequest(s.deps, user, req.id)).toEqual({ status: "cancelled" });
    expect(s.rows.get(req.id)!.status).toBe("cancelled");
    expect(s.n8n.cancelEvent).not.toHaveBeenCalled();
    expect(s.audits.at(-1)?.action).toBe("event_cancelled");
  });

  it("confirmed: cancella su Google poi annulla", async () => {
    const s = setup();
    const req = await proposed(s);
    await confirmRequest(s.deps, user, req.id, false);
    expect(await cancelRequest(s.deps, user, req.id)).toEqual({ status: "cancelled" });
    expect(s.n8n.cancelEvent).toHaveBeenCalledWith({ requestId: req.id, googleEventId: "g1" });
    expect(s.rows.get(req.id)!.status).toBe("cancelled");
  });

  it("confirmed ma n8n fallisce: resta confirmed, errore", async () => {
    const s = setup();
    const req = await proposed(s);
    await confirmRequest(s.deps, user, req.id, false);
    s.n8n.cancelEvent.mockRejectedValueOnce(new N8nError("timeout", "t"));
    const r = await cancelRequest(s.deps, user, req.id);
    expect(r.status).toBe("error");
    expect(s.rows.get(req.id)!.status).toBe("confirmed");
  });

  it("già cancellata o altrui: errore", async () => {
    const s = setup();
    const req = await proposed(s);
    await cancelRequest(s.deps, user, req.id);
    expect((await cancelRequest(s.deps, user, req.id)).status).toBe("error");
    expect((await cancelRequest(s.deps, { ...user, id: "u2" }, req.id)).status).toBe("error");
  });
});
