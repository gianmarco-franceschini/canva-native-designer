import { NextResponse } from "next/server";

/**
 * Protezione CSRF per le route che modificano dati: l'header `Origin` deve essere
 * esattamente l'origine della richiesta (schema + host). Host e schema arrivano da
 * `x-forwarded-*` dietro il proxy di Vercel, altrimenti da `Host` e dall'URL.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const url = new URL(request.url);
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = first(request.headers.get("x-forwarded-host")) ?? request.headers.get("host") ?? url.host;
  const proto = first(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  return origin === `${proto}://${host}`;
}

export const jsonError = (status: number, error: string) =>
  NextResponse.json({ error }, { status });

export const unauthorized = () => jsonError(401, "Non autenticato");
export const forbidden = () => jsonError(403, "Origine della richiesta non consentita");
