import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { DbClient } from "@/lib/db/repo";
import type { Database } from "@/lib/db/types";
import { publicEnv } from "@/lib/env";

/**
 * Client Supabase con la sessione dell'utente (cookie) → soggetto a RLS.
 * Nei Server Component i cookie non sono scrivibili: il rinnovo della sessione
 * avviene nel middleware, quindi l'errore di scrittura qui è ignorato.
 */
export async function createServerSupabase(): Promise<DbClient> {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component: ignorato, il middleware rinnova la sessione.
          }
        },
      },
    },
  );
}
