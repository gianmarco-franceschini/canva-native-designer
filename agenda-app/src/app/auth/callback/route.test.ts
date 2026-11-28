import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  exchange: { data: { user: null as unknown }, error: null as unknown },
  row: null as unknown,
  rowError: null as unknown,
  signOut: vi.fn(async () => ({ error: null })),
  exchangeCalls: [] as string[],
  audits: [] as unknown[],
  auditFails: false,
}));

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ ALLOWED_DOMAIN: "example.com" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: {
      exchangeCodeForSession: async (code: string) => {
        m.exchangeCalls.push(code);
        return m.exchange;
      },
      signOut: m.signOut,
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createServiceSupabase: () => ({
    from(table: string) {
      if (table === "audit_log") {
        return {
          insert: async (row: unknown) => {
            m.audits.push(row);
            return { error: m.auditFails ? { message: "x" } : null };
          },
        };
      }
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: m.row, error: m.rowError }),
      };
      return b;
    },
  }),
}));

const { GET } = await import("./route");

const call = (qs: string) => GET(new NextRequest(`https://agenda.example.com/auth/callback${qs}`));

const googleUser = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  email: "mario@example.com",
  app_metadata: { provider: "google" },
  user_metadata: { custom_claims: { hd: "example.com" } },
  ...over,
});

function expectDenied(res: Response) {
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("https://agenda.example.com/login?error=denied");
}

beforeEach(() => {
  m.exchange = { data: { user: googleUser() }, error: null };
  m.row = { full_name: "Mario Rossi", role: "user", active: true };
  m.rowError = null;
  m.signOut.mockClear();
  m.exchangeCalls = [];
  m.audits = [];
  m.auditFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /auth/callback", () => {
  it("utente del dominio attivo → /", async () => {
    const res = await call("?code=abc");
    expect(m.exchangeCalls).toEqual(["abc"]);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://agenda.example.com/");
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.audits).toEqual([]);
  });

  it("senza codice → denied, nessuno scambio né audit", async () => {
    expectDenied(await call("?error=server_error&error_description=Database+error"));
    expect(m.exchangeCalls).toEqual([]);
    expect(m.audits).toEqual([]);
  });

  it("scambio fallito → denied", async () => {
    m.exchange = { data: { user: null }, error: { message: "bad code" } };
    expectDenied(await call("?code=abc"));
    expect(m.audits).toEqual([]);
  });

  it.each([
    ["email fuori dominio", googleUser({ email: "x@evil-example.com" }), "domain"],
    ["senza hd", googleUser({ user_metadata: {} }), "domain"],
    ["hd diverso", googleUser({ user_metadata: { custom_claims: { hd: "other.com" } } }), "domain"],
    ["provider non google", googleUser({ app_metadata: { provider: "email" } }), "domain"],
  ])("%s → logout, audit, denied", async (_n, user, reason) => {
    m.exchange = { data: { user }, error: null };
    expectDenied(await call("?code=abc"));
    expect(m.signOut).toHaveBeenCalledOnce();
    expect(m.audits).toEqual([
      expect.objectContaining({ action: "login_denied", actor_id: "u1", details: { reason } }),
    ]);
  });

  it.each([
    ["disattivato", { full_name: "M", role: "user", active: false }],
    ["assente", null],
  ])("utente %s in allowed_users → logout, audit, denied", async (_n, row) => {
    m.row = row;
    expectDenied(await call("?code=abc"));
    expect(m.signOut).toHaveBeenCalledOnce();
    expect(m.audits).toEqual([
      expect.objectContaining({
        action: "login_denied",
        actor_email: "mario@example.com",
        details: { reason: "not_allowed" },
      }),
    ]);
  });

  it("errore di lettura allowed_users → denied (fail closed)", async () => {
    m.rowError = { message: "boom" };
    expectDenied(await call("?code=abc"));
    expect(m.signOut).toHaveBeenCalledOnce();
  });

  it("audit fallito non sblocca l'accesso", async () => {
    m.row = null;
    m.auditFails = true;
    expectDenied(await call("?code=abc"));
  });
});
