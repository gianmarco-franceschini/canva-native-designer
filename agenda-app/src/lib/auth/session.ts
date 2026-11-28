import "server-only";
import { notFound, redirect } from "next/navigation";
import type { DbClient } from "@/lib/db/repo";
import { serverEnv } from "@/lib/env";
import type { User } from "@/lib/requests/service";
import { createServiceSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { isAllowedGoogleUser } from "./domain";

export type Role = "user" | "admin";
export type SessionUser = User & { role: Role };

export const LOGIN_PATH = "/login";
export const DENIED_PATH = "/login?error=denied";

type AllowedUser = { fullName: string; role: Role };

/**
 * Voce attiva di `allowed_users` per `email` (già minuscola), o null. Usa il client
 * service_role perché `allowed_users` è leggibile solo dagli admin. Su errore lancia:
 * mai trattare un errore di lettura come autorizzazione.
 */
export async function findActiveAllowedUser(
  service: DbClient,
  email: string,
): Promise<AllowedUser | null> {
  const { data, error } = await service
    .from("allowed_users")
    .select("full_name, role, active")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`allowed_users: ${error.message}`);
  if (!data || data.active !== true) return null;
  if (data.role !== "user" && data.role !== "admin") return null;
  return { fullName: data.full_name, role: data.role };
}

type SessionCheck = { kind: "none" } | { kind: "denied" } | { kind: "ok"; user: SessionUser };

/**
 * Verifica la sessione corrente a ogni chiamata: sessione valida (getUser verifica il token
 * presso Supabase), account Google del dominio e voce ancora attiva in `allowed_users`, da
 * cui provengono nome e ruolo. Un utente non più autorizzato viene disconnesso.
 */
async function checkSession(): Promise<SessionCheck> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "none" };

  const email = user.email?.toLowerCase();
  const allowed =
    email && isAllowedGoogleUser(user, serverEnv().ALLOWED_DOMAIN)
      ? await findActiveAllowedUser(createServiceSupabase(), email)
      : null;

  if (!email || !allowed) {
    try {
      await supabase.auth.signOut();
    } catch {
      // Il rifiuto non dipende dall'esito del logout.
    }
    return { kind: "denied" };
  }

  return {
    kind: "ok",
    user: { id: user.id, email, fullName: allowed.fullName, role: allowed.role },
  };
}

/**
 * Utente della sessione corrente (vedi `checkSession`). Senza sessione → `/login`; utente
 * non più autorizzato → logout e `/login?error=denied`.
 */
export async function requireUser(): Promise<SessionUser> {
  const s = await checkSession();
  if (s.kind === "none") redirect(LOGIN_PATH);
  if (s.kind === "denied") redirect(DENIED_PATH);
  return s.user;
}

/**
 * Variante per le route API: stessi controlli di `requireUser`, ma senza redirect.
 * Restituisce null se non c'è sessione o l'utente non è (più) autorizzato: la route
 * risponde 401.
 */
export async function getApiUser(): Promise<SessionUser | null> {
  const s = await checkSession();
  return s.kind === "ok" ? s.user : null;
}

/** Come `requireUser`, ma risponde 404 a chi non è admin (non rivela l'esistenza della pagina). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}
