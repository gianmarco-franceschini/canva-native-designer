import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  user: null as unknown,
  deps: { marker: "deps" },
  confirm: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getApiUser: async () => m.user }));
vi.mock("@/lib/requests/deps", () => ({ createRequestDeps: async () => m.deps }));
vi.mock("@/lib/requests/service", () => ({
  confirmRequest: m.confirm,
  cancelRequest: m.cancel,
}));

const confirmRoute = await import("./[id]/confirm/route");
const cancelRoute = await import("./[id]/cancel/route");

const ID = "0b9f7a52-5a0c-4a43-9a43-2f6f3c1b1e01";
const user = { id: "u1", email: "anna@example.com", fullName: "Anna Rossi", role: "user" };

function req(
  action: "confirm" | "cancel",
  { origin = "https://agenda.example.com", body = { allowConflict: false } as unknown } = {},
) {
  const headers: Record<string, string> = {
    host: "agenda.example.com",
    "content-type": "application/json",
  };
  if (origin) headers.origin = origin;
  return new NextRequest(`https://agenda.example.com/api/requests/${ID}/${action}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  m.user = user;
  m.confirm.mockReset();
  m.cancel.mockReset();
});

describe("POST /api/requests/:id/confirm", () => {
  it("senza sessione → 401", async () => {
    m.user = null;
    const res = await confirmRoute.POST(req("confirm"), params());
    expect(res.status).toBe(401);
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["estraneo", "https://evil.example.net"],
    ["stesso host ma altro schema", "http://agenda.example.com"],
    ["assente", ""],
    ["null", "null"],
  ])("Origin %s → 403", async (_n, origin) => {
    const res = await confirmRoute.POST(req("confirm", { origin }), params());
    expect(res.status).toBe(403);
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("conferma: passa utente, id e allowConflict al servizio", async () => {
    m.confirm.mockResolvedValue({ status: "confirmed", htmlLink: "https://calendar.google.com/x" });
    const res = await confirmRoute.POST(req("confirm", { body: { allowConflict: true } }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "confirmed",
      htmlLink: "https://calendar.google.com/x",
    });
    expect(m.confirm).toHaveBeenCalledWith(m.deps, user, ID, true);
  });

  it("conflitto → 409 con i conflitti", async () => {
    m.confirm.mockResolvedValue({
      status: "conflict",
      conflicts: [
        {
          email: "giulia@example.com",
          start: new Date("2026-11-27T09:00:00Z"),
          end: new Date("2026-11-27T10:00:00Z"),
        },
      ],
    });
    const res = await confirmRoute.POST(req("confirm"), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: "conflict",
      conflicts: [
        {
          email: "giulia@example.com",
          start: "2026-11-27T09:00:00.000Z",
          end: "2026-11-27T10:00:00.000Z",
        },
      ],
    });
  });

  it("errore del servizio → 422 con messaggio", async () => {
    m.confirm.mockResolvedValue({ status: "error", message: "Richiesta già confermata." });
    const res = await confirmRoute.POST(req("confirm"), params());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ status: "error", message: "Richiesta già confermata." });
  });

  it.each([
    ["non JSON", "{"],
    ["allowConflict mancante", {}],
    ["allowConflict non booleano", { allowConflict: "true" }],
  ])("corpo %s → 400", async (_n, body) => {
    const res = await confirmRoute.POST(req("confirm", { body }), params());
    expect(res.status).toBe(400);
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it("id non UUID → 404", async () => {
    const res = await confirmRoute.POST(req("confirm"), params("abc"));
    expect(res.status).toBe(404);
    expect(m.confirm).not.toHaveBeenCalled();
  });
});

describe("POST /api/requests/:id/cancel", () => {
  it("senza sessione → 401", async () => {
    m.user = null;
    const res = await cancelRoute.POST(req("cancel"), params());
    expect(res.status).toBe(401);
  });

  it("Origin estraneo → 403", async () => {
    const res = await cancelRoute.POST(req("cancel", { origin: "https://evil.example.net" }), params());
    expect(res.status).toBe(403);
    expect(m.cancel).not.toHaveBeenCalled();
  });

  it("annulla → 200", async () => {
    m.cancel.mockResolvedValue({ status: "cancelled" });
    const res = await cancelRoute.POST(req("cancel"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
    expect(m.cancel).toHaveBeenCalledWith(m.deps, user, ID);
  });

  it("errore → 422", async () => {
    m.cancel.mockResolvedValue({ status: "error", message: "Richiesta non trovata." });
    const res = await cancelRoute.POST(req("cancel"), params());
    expect(res.status).toBe(422);
  });
});
