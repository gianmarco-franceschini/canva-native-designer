import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { DbClient } from "@/lib/db/repo";
import type { Database } from "@/lib/db/types";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Client service_role: scavalca la RLS. Solo lato server, mai con la sessione
 * dell'utente; chi lo usa deve filtrare esplicitamente per utente.
 */
export function createServiceSupabase(): DbClient {
  return createClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}
