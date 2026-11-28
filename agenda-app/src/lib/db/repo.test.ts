import { describe, expect, it } from "vitest";
import { createSupabaseRepo, type DbClient } from "./repo";

type Call = { table: string; ops: [string, ...unknown[]][] };

/** Client finto: registra la catena di chiamate e risolve con `result`. */
function fakeClient(result: { data?: unknown; error?: unknown; count?: number }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
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

  it("transitionRequest: un solo UPDATE filtrato per id, user_id e stato di partenza", async () => {
    const { client, calls } = fakeClient({
      data: { ...row, status: "confirmed", confirmed_at: "2026-11-28T11:00:00+00:00" },
    });
    const confirmedAt = new Date("2026-11-28T11:00:00Z");
    const r = await createSupabaseRepo(client, client).transitionRequest(
      "r1",
      "u1",
      "confirming",
      "confirmed",
      { googleEventId: "g1", confirmedAt, userId: "intruso", status: "cancelled" },
    );
    expect(r?.confirmedAt).toEqual(confirmedAt);
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
