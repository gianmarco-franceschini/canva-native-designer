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

/**
 * Utente della sessione corrente, verificato a ogni chiamata: sessione valida (getUser
 * verifica il token presso Supabase), account Google del dominio e voce ancora attiva in
 * `allowed_users`, da cui provengono nome e ruolo. Senza sessione → `/login`; utente non
 * più autorizzato → logout e `/login?error=denied`.
 */
export async function requireUser(): Promise<SessionUser> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(LOGIN_PATH);

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
    redirect(DENIED_PATH);
  }

  return { id: user.id, email, fullName: allowed.fullName, role: allowed.role };
}

/** Come `requireUser`, ma risponde 404 a chi non è admin (non rivela l'esistenza della pagina). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}
