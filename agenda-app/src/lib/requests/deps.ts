import "server-only";
import { createSupabaseRepo } from "@/lib/db/repo";
import { serverEnv } from "@/lib/env";
import { createN8nClient } from "@/lib/n8n/client";
import { createServiceSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Deps } from "./service";

/** Dipendenze del servizio richieste per la richiesta HTTP corrente (sessione dai cookie). */
export async function createRequestDeps(): Promise<Deps> {
  const env = serverEnv();
  return {
    repo: createSupabaseRepo(await createServerSupabase(), createServiceSupabase()),
    n8n: createN8nClient({ baseUrl: env.N8N_BASE_URL, secret: env.N8N_WEBHOOK_SECRET }),
    now: () => new Date(),
  };
}
