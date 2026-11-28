import { NextResponse, type NextRequest } from "next/server";
import { isAllowedGoogleUser } from "@/lib/auth/domain";
import { DENIED_PATH, findActiveAllowedUser } from "@/lib/auth/session";
import { createSupabaseRepo } from "@/lib/db/repo";
import { serverEnv } from "@/lib/env";
import { createServiceSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Ritorno dall'OAuth Google: scambia il codice (PKCE) per la sessione, poi ammette solo
 * account Google del dominio (email + claim `hd`) attivi in `allowed_users`. Ogni altro
 * esito → logout, audit `login_denied` (quando c'è un utente) e `/login?error=denied`.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const denied = () => NextResponse.redirect(new URL(DENIED_PATH, origin));

  const code = request.nextUrl.searchParams.get("code");
  // Senza codice (es. utente rifiutato dal guard del DB: Supabase rimanda con ?error=…):
  // nessuna sessione da chiudere; niente audit, l'endpoint è raggiungibile da chiunque.
  if (!code) return denied();

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return denied();
  const user = data.user;

  const service = createServiceSupabase();
  let reason: string | null = null;
  try {
    const email = user.email?.toLowerCase();
    if (!email || !isAllowedGoogleUser(user, serverEnv().ALLOWED_DOMAIN)) {
      reason = "domain";
    } else if (!(await findActiveAllowedUser(service, email))) {
      reason = "not_allowed";
    }
  } catch {
    reason = "check_failed";
  }
  if (!reason) return NextResponse.redirect(new URL("/", origin));

  try {
    await supabase.auth.signOut();
  } catch {
    // Il rifiuto non dipende dall'esito del logout.
  }
  try {
    await createSupabaseRepo(supabase, service).audit({
      actorId: user.id,
      actorEmail: user.email ?? null,
      action: "login_denied",
      targetType: "auth",
      targetId: null,
      details: { reason },
    });
  } catch (e) {
    console.error("audit login_denied non registrato", e);
  }
  return denied();
}
