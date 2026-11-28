import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (c: { name: string; value: string; options: object }[], headers: Record<string, string>) => void;
};

const state: { user: unknown; cookies?: CookieMethods; refresh?: boolean } = { user: null };

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: CookieMethods }) => {
    state.cookies = opts.cookies;
    return {
      auth: {
        getUser: async () => {
          if (state.refresh) {
            opts.cookies.setAll([{ name: "sb-tok", value: "nuovo", options: { path: "/" } }], {
              "Cache-Control": "private, no-store",
            });
          }
          return { data: { user: state.user }, error: null };
        },
      },
    };
  },
}));

const { middleware, config } = await import("./middleware");

const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(path, "https://agenda.example.com"), init);

beforeEach(() => {
  state.user = null;
  state.refresh = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NODE_ENV", "production");
});

describe("middleware: accesso", () => {
  it("senza sessione, / → redirect a /login", async () => {
    const res = await middleware(req("/"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(res.headers.get("location")!).origin).toBe("https://agenda.example.com");
  });

  it("senza sessione, pagine annidate → redirect a /login", async () => {
    const res = await middleware(req("/admin/utenti"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("senza sessione, /api/* → 401 JSON (nessun redirect)", async () => {
    const res = await middleware(req("/api/requests", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Non autenticato" });
  });

  it("/login e /auth/callback passano senza sessione", async () => {
    for (const p of ["/login", "/login?error=denied", "/auth/callback?code=abc"]) {
      const res = await middleware(req(p));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("percorsi solo simili a quelli pubblici non passano", async () => {
    for (const p of ["/loginx", "/login-admin", "/auth/callbackx", "/auth"]) {
      const res = await middleware(req(p));
      expect(res.status, p).toBe(307);
    }
  });

  it("con sessione, / passa", async () => {
    state.user = { id: "u1", email: "mario@example.com" };
    const res = await middleware(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("legge i cookie della richiesta e propaga quelli rinnovati", async () => {
    state.user = { id: "u1" };
    state.refresh = true;
    const res = await middleware(req("/", { headers: { cookie: "sb-tok=vecchio" } }));
    expect(state.cookies!.getAll()).toContainEqual({ name: "sb-tok", value: "nuovo" });
    expect(res.cookies.get("sb-tok")?.value).toBe("nuovo");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("i cookie rinnovati arrivano anche sul redirect", async () => {
    state.refresh = true;
    const res = await middleware(req("/"));
    expect(res.status).toBe(307);
    expect(res.cookies.get("sb-tok")?.value).toBe("nuovo");
  });
});

describe("middleware: CSP con nonce", () => {
  function nonceOf(csp: string) {
    return /'nonce-([^']+)'/.exec(csp)?.[1];
  }

  it("imposta una CSP con nonce per richiesta, inoltrata anche come x-nonce", async () => {
    const res = await middleware(req("/login"));
    const csp = res.headers.get("content-security-policy")!;
    const nonce = nonceOf(csp);
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);

    const other = nonceOf((await middleware(req("/login"))).headers.get("content-security-policy")!);
    expect(other).not.toBe(nonce);
  });

  it("direttive attese in produzione", async () => {
    const csp = (await middleware(req("/login"))).headers.get("content-security-policy")!;
    const d = Object.fromEntries(
      csp.split(";").map((s) => {
        const [k, ...v] = s.trim().split(/\s+/);
        return [k, v.join(" ")];
      }),
    );
    expect(d["default-src"]).toBe("'self'");
    expect(d["script-src"]).toMatch(/^'self' 'nonce-[^']+' 'strict-dynamic'$/);
    expect(d["style-src"]).toBe("'self' 'unsafe-inline'");
    expect(d["font-src"]).toBe("'self'");
    expect(d["img-src"]).toBe("'self' data:");
    expect(d["connect-src"]).toBe("'self' https://proj.supabase.co wss://proj.supabase.co");
    expect(d["frame-ancestors"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'self'");
    expect(d["form-action"]).toBe("'self' https://proj.supabase.co https://accounts.google.com");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("'unsafe-eval' solo in sviluppo", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const csp = (await middleware(req("/login"))).headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic' 'unsafe-eval'/);
  });

  it("CSP presente anche su redirect e 401", async () => {
    expect((await middleware(req("/"))).headers.get("content-security-policy")).toContain("nonce-");
    expect((await middleware(req("/api/x"))).headers.get("content-security-policy")).toContain("nonce-");
  });
});

describe("middleware: matcher", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  it("esclude asset statici, immagini e favicon", () => {
    expect(re.test("/_next/static/chunks/a.js")).toBe(false);
    expect(re.test("/_next/image")).toBe(false);
    expect(re.test("/favicon.ico")).toBe(false);
  });
  it("include pagine e API", () => {
    expect(re.test("/")).toBe(true);
    expect(re.test("/login")).toBe(true);
    expect(re.test("/api/requests")).toBe(true);
  });
});
