import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  user: null as unknown,
  row: null as unknown,
  rowError: null as unknown,
  signOut: vi.fn(async () => ({ error: null })),
  queries: [] as unknown[][],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ ALLOWED_DOMAIN: "example.com" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: m.user }, error: null }), signOut: m.signOut },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createServiceSupabase: () => ({
    from(table: string) {
      const q: unknown[] = [table];
      m.queries.push(q);
      const b = {
        select: (...a: unknown[]) => (q.push(["select", ...a]), b),
        eq: (...a: unknown[]) => (q.push(["eq", ...a]), b),
        maybeSingle: async () => ({ data: m.row, error: m.rowError }),
      };
      return b;
    },
  }),
}));

const { requireUser, requireAdmin, getApiUser } = await import("./session");

const googleUser = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  email: "Mario@Example.com",
  app_metadata: { provider: "google" },
  user_metadata: { custom_claims: { hd: "example.com" } },
  ...over,
});

beforeEach(() => {
  m.user = googleUser();
  m.row = { full_name: "Mario Rossi", role: "user", active: true };
  m.rowError = null;
  m.signOut.mockClear();
  m.queries = [];
});

describe("requireUser", () => {
  it("senza sessione → redirect /login, senza logout", async () => {
    m.user = null;
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(m.signOut).not.toHaveBeenCalled();
  });

  it("utente attivo: dati e ruolo da allowed_users, email minuscola", async () => {
    m.row = { full_name: "Mario Rossi", role: "admin", active: true };
    await expect(requireUser()).resolves.toEqual({
      id: "u1",
      email: "mario@example.com",
      fullName: "Mario Rossi",
      role: "admin",
    });
    expect(m.queries).toEqual([
      ["allowed_users", ["select", "full_name, role, active"], ["eq", "email", "mario@example.com"]],
    ]);
  });

  it("controlla allowed_users a ogni chiamata", async () => {
    await requireUser();
    await requireUser();
    expect(m.queries).toHaveLength(2);
  });

  it.each([
    ["disattivato", { full_name: "M", role: "user", active: false }],
    ["assente", null],
    ["ruolo sconosciuto", { full_name: "M", role: "root", active: true }],
  ])("utente %s → logout e /login?error=denied", async (_n, row) => {
    m.row = row;
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login?error=denied");
    expect(m.signOut).toHaveBeenCalledOnce();
  });

  it.each([
    ["fuori dominio", googleUser({ email: "mario@gmail.com" })],
    ["senza email", googleUser({ email: undefined })],
    ["provider non google", googleUser({ app_metadata: { provider: "email" } })],
    ["senza hd", googleUser({ user_metadata: {} })],
  ])("utente %s → negato senza interrogare allowed_users", async (_n, user) => {
    m.user = user;
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login?error=denied");
    expect(m.signOut).toHaveBeenCalledOnce();
    expect(m.queries).toHaveLength(0);
  });

  it("il rifiuto vale anche se il logout fallisce", async () => {
    m.row = null;
    m.signOut.mockRejectedValueOnce(new Error("rete"));
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login?error=denied");
  });

  it("errore di lettura di allowed_users → lancia (mai autorizzato)", async () => {
    m.rowError = { message: "boom" };
    await expect(requireUser()).rejects.toThrow("allowed_users: boom");
  });
});

describe("requireAdmin", () => {
  it("admin → utente", async () => {
    m.row = { full_name: "A", role: "admin", active: true };
    await expect(requireAdmin()).resolves.toMatchObject({ role: "admin" });
  });

  it("non admin → 404", async () => {
    await expect(requireAdmin()).rejects.toThrow("NOT_FOUND");
  });
});

describe("getApiUser", () => {
  it("senza sessione → null, senza logout", async () => {
    m.user = null;
    await expect(getApiUser()).resolves.toBeNull();
    expect(m.signOut).not.toHaveBeenCalled();
  });

  it("utente attivo → utente", async () => {
    await expect(getApiUser()).resolves.toEqual({
      id: "u1",
      email: "mario@example.com",
      fullName: "Mario Rossi",
      role: "user",
    });
  });

  it("utente disattivato → null e logout (ricontrolla allowed_users)", async () => {
    m.row = { full_name: "M", role: "user", active: false };
    await expect(getApiUser()).resolves.toBeNull();
    expect(m.signOut).toHaveBeenCalledOnce();
    expect(m.queries).toHaveLength(1);
  });

  it("errore di lettura di allowed_users → lancia", async () => {
    m.rowError = { message: "boom" };
    await expect(getApiUser()).rejects.toThrow("allowed_users: boom");
  });
});
