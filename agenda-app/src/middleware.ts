import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Percorsi accessibili senza sessione (corrispondenza esatta del path). */
const PUBLIC_PATHS = new Set(["/login", "/auth/callback"]);

function supabaseOrigin(url: string): string {
  return new URL(url).origin;
}

/** CSP per richiesta: gli script sono ammessi solo con il nonce (Next lo applica ai suoi). */
export function buildCsp(nonce: string, supabaseUrl: string, isDev: boolean): string {
  const origin = supabaseOrigin(supabaseUrl);
  const wss = origin.replace(/^https:/, "wss:");
  const connect = ["'self'", origin, wss !== origin ? wss : null].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `form-action 'self' ${origin} https://accounts.google.com`,
  ].join("; ");
}

function requirePublic(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Variabile d'ambiente mancante: ${name}`);
  return value;
}

/**
 * 1. Genera il nonce e la CSP; li inoltra a Next come header di richiesta
 *    (`x-nonce`, `content-security-policy`) e imposta la CSP sulla risposta.
 * 2. Rinnova la sessione Supabase (pattern @supabase/ssr) propagando i cookie.
 * 3. Senza sessione: `/api/*` → 401 JSON, altre pagine non pubbliche → `/login`.
 * Il controllo di dominio e di `allowed_users` resta a callback e `requireUser`.
 */
export async function middleware(request: NextRequest) {
  const supabaseUrl = requirePublic("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = requirePublic(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, supabaseUrl, process.env.NODE_ENV === "development");

  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return NextResponse.next({ request: { headers } });
  };

  let response = forward();
  const refreshed: { name: string; value: string; options: object }[] = [];
  let refreshHeaders: Record<string, string> = {};

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
        refreshed.push(...cookiesToSet);
        refreshHeaders = { ...refreshHeaders, ...headers };
      },
    },
  });

  // Non inserire codice tra createServerClient e getUser (indicazione @supabase/ssr).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  if (!user && !PUBLIC_PATHS.has(pathname)) {
    const denied = pathname === "/api" || pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Non autenticato" }, { status: 401 })
      : NextResponse.redirect(new URL("/login", request.url));
    // I cookie rinnovati/cancellati da Supabase devono arrivare anche qui.
    for (const { name, value, options } of refreshed) denied.cookies.set(name, value, options);
    for (const [k, v] of Object.entries(refreshHeaders)) denied.headers.set(k, v);
    response = denied;
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
