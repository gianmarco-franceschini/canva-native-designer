import { describe, expect, it } from "vitest";
import { createSupabaseRepo, type DbClient } from "./repo";

type Call = { table: string; ops: [string, ...unknown[]][] };

type Result = { data?: unknown; error?: unknown; count?: number };

/**
 * Client finto: registra la catena di chiamate; la n-esima chiamata a from()/rpc() risolve
 * con l'n-esimo risultato (l'ultimo si ripete).
 */
function fakeClient(...results: Result[]) {
  const calls: Call[] = [];
  const next = () => results[Math.min(calls.length - 1, results.length - 1)] ?? {};
  const client = {
    rpc(fn: string) {
      calls.push({ table: `rpc:${fn}`, ops: [] });
      return Promise.resolve({ data: null, error: null, ...next() });
    },
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const result = next();
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "eq", "gte", "order", "single", "maybeSingle"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null, count: null, ...result });
      return builder;
    },
  };
  return { client: client as unknown as DbClient, calls };
}

const row = {
  id: "r1",
  user_id: "u1",
  title: "Riunione",
  description: null,
  start_at: "2026-12-01T08:00:00+00:00",
  end_at: "2026-12-01T09:00:00+00:00",
  attendee_emails: ["giulia@d.it"],
  status: "confirming",
  conflict_snapshot: { conflicts: [] },
  google_event_id: null,
  google_event_link: null,
  created_at: "2026-11-28T10:00:00+00:00",
  confirmed_at: null,
  error: null,
};

describe("createSupabaseRepo", () => {
  it("converte la riga in EventRequest", async () => {
    const { client } = fakeClient({ data: row });
    const r = await createSupabaseRepo(client, client).getRequest("r1", "u1");
    expect(r).toEqual({
      id: "r1",
      userId: "u1",
      title: "Riunione",
      description: null,
      startAt: new Date("2026-12-01T08:00:00Z"),
      endAt: new Date("2026-12-01T09:00:00Z"),
      attendeeEmails: ["giulia@d.it"],
      status: "confirming",
      conflictSnapshot: { conflicts: [] },
      googleEventId: null,
      googleEventLink: null,
      createdAt: new Date("2026-11-28T10:00:00Z"),
      confirmedAt: null,
      error: null,
    });
  });

  it("transitionRequest: un solo UPDATE via service client filtrato per id, user_id e stato", async () => {
    const user = fakeClient({});
    const { client, calls } = fakeClient({
      data: { ...row, status: "confirmed", confirmed_at: "2026-11-28T11:00:00+00:00" },
    });
    const confirmedAt = new Date("2026-11-28T11:00:00Z");
    const r = await createSupabaseRepo(user.client, client).transitionRequest(
      "r1",
      "u1",
      "confirming",
      "confirmed",
      { googleEventId: "g1", confirmedAt, userId: "intruso", status: "cancelled" },
    );
    expect(r?.confirmedAt).toEqual(confirmedAt);
    expect(user.calls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("event_requests");
    expect(calls[0].ops).toEqual([
      ["update", { google_event_id: "g1", confirmed_at: confirmedAt.toISOString(), status: "confirmed" }],
      ["eq", "id", "r1"],
      ["eq", "user_id", "u1"],
      ["eq", "status", "confirming"],
      ["select"],
      ["maybeSingle"],
    ]);
  });

  it("transitionRequest restituisce null se nessuna riga è cambiata", async () => {
    const { client } = fakeClient({ data: null });
    expect(
      await createSupabaseRepo(client, client).transitionRequest("r1", "u1", "pending", "confirming"),
    ).toBeNull();
  });

  it("insertRequest: via service client con user_id esplicito", async () => {
    const user = fakeClient({});
    const service = fakeClient({ data: { ...row, status: "pending" } });
    const r = await createSupabaseRepo(user.client, service.client).insertRequest({
      userId: "u1",
      title: "Riunione",
      description: null,
      startAt: new Date("2026-12-01T08:00:00Z"),
      endAt: new Date("2026-12-01T09:00:00Z"),
      attendeeEmails: ["giulia@d.it"],
      conflictSnapshot: null,
    });
    expect(r.status).toBe("pending");
    expect(user.calls).toHaveLength(0);
    expect(service.calls[0].table).toBe("event_requests");
    expect(service.calls[0].ops[0]).toEqual([
      "insert",
      {
        user_id: "u1",
        title: "Riunione",
        description: null,
        start_at: "2026-12-01T08:00:00.000Z",
        end_at: "2026-12-01T09:00:00.000Z",
        attendee_emails: ["giulia@d.it"],
        conflict_snapshot: null,
      },
    ]);
  });

  it("listColleagues: chiama list_colleagues() con il client utente", async () => {
    const user = fakeClient({ data: [{ email: "giulia@d.it", full_name: "Giulia Bianchi" }] });
    const service = fakeClient({});
    expect(await createSupabaseRepo(user.client, service.client).listColleagues()).toEqual([
      { email: "giulia@d.it", fullName: "Giulia Bianchi" },
    ]);
    expect(user.calls.map((c) => c.table)).toEqual(["rpc:list_colleagues"]);
    expect(service.calls).toHaveLength(0);
  });

  it("appendMessage: verifica la proprietà della conversation e poi inserisce via service", async () => {
    const user = fakeClient({});
    const service = fakeClient({ data: { id: "c1" } }, {});
    await createSupabaseRepo(user.client, service.client).appendMessage("u1", "c1", "user", {
      text: "ciao",
    });
    expect(user.calls).toHaveLength(0);
    expect(service.calls.map((c) => c.table)).toEqual(["conversations", "messages"]);
    expect(service.calls[0].ops).toContainEqual(["eq", "id", "c1"]);
    expect(service.calls[0].ops).toContainEqual(["eq", "user_id", "u1"]);
    expect(service.calls[1].ops[0]).toEqual([
      "insert",
      { conversation_id: "c1", role: "user", content: { text: "ciao" } },
    ]);
  });

  it("appendMessage: conversation altrui → errore, nessun insert", async () => {
    const service = fakeClient({ data: null });
    await expect(
      createSupabaseRepo(fakeClient({}).client, service.client).appendMessage("u1", "c2", "user", "x"),
    ).rejects.toThrow("conversation non trovata");
    expect(service.calls.map((c) => c.table)).toEqual(["conversations"]);
  });

  it("createConversation: via service client con user_id esplicito", async () => {
    const service = fakeClient({
      data: { id: "c1", user_id: "u1", title: "t", created_at: "2026-11-28T10:00:00+00:00" },
    });
    const c = await createSupabaseRepo(fakeClient({}).client, service.client).createConversation(
      "u1",
      "t",
    );
    expect(c).toEqual({ id: "c1", userId: "u1", title: "t", createdAt: new Date("2026-11-28T10:00:00Z") });
    expect(service.calls[0].ops[0]).toEqual(["insert", { user_id: "u1", title: "t" }]);
  });

  it("countUserMessagesSince: conta le righe chat_message di audit_log dell'utente", async () => {
    const user = fakeClient({});
    const service = fakeClient({ count: 7 });
    const since = new Date("2026-11-28T10:00:00Z");
    expect(
      await createSupabaseRepo(user.client, service.client).countUserMessagesSince("u1", since),
    ).toBe(7);
    expect(user.calls).toHaveLength(0);
    expect(service.calls[0].table).toBe("audit_log");
    expect(service.calls[0].ops).toEqual([
      ["select", "id", { count: "exact", head: true }],
      ["eq", "action", "chat_message"],
      ["eq", "actor_id", "u1"],
      ["gte", "created_at", since.toISOString()],
    ]);
  });

  it("audit usa il client di servizio", async () => {
    const user = fakeClient({});
    const service = fakeClient({});
    await createSupabaseRepo(user.client, service.client).audit({
      actorId: "u1",
      actorEmail: "a@d.it",
      action: "login_denied",
      targetType: "user",
      targetId: null,
      details: { reason: "domain" },
    });
    expect(user.calls).toHaveLength(0);
    expect(service.calls[0].table).toBe("audit_log");
  });

  it("propaga gli errori del database", async () => {
    const { client } = fakeClient({ error: { message: "boom" } });
    await expect(createSupabaseRepo(client, client).getRequest("r1", "u1")).rejects.toThrow(
      "db getRequest: boom",
    );
  });
});
