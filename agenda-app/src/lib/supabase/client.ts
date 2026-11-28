import { createBrowserClient } from "@supabase/ssr";
import type { DbClient } from "@/lib/db/repo";
import type { Database } from "@/lib/db/types";

/**
 * Client Supabase per il browser (chiave anon, sessione nei cookie). `@/lib/env` è
 * `server-only`: qui gli accessi `process.env.NEXT_PUBLIC_*` letterali sono sostituiti
 * da Next.js in fase di build.
 */
export function createBrowserSupabase(): DbClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Configurazione Supabase mancante");
  return createBrowserClient<Database>(url, key);
}
