import "server-only";
import { z } from "zod";

const serverSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  N8N_BASE_URL: z.string().url(),
  N8N_WEBHOOK_SECRET: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ALLOWED_DOMAIN: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/** Variabili segrete, solo lato server. Lancia citando i nomi mancanti. */
export function serverEnv(): ServerEnv {
  const parsed = serverSchema.safeParse({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    N8N_BASE_URL: process.env.N8N_BASE_URL,
    N8N_WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ALLOWED_DOMAIN: process.env.ALLOWED_DOMAIN,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Variabili d'ambiente mancanti o non valide: ${missing}`);
  }
  return parsed.data;
}

function requirePublic(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Variabile d'ambiente mancante: ${name}`);
  return value;
}

/**
 * Variabili pubbliche. Gli accessi a `process.env.NEXT_PUBLIC_*` devono essere
 * letterali perché Next.js li sostituisca in fase di build; la validazione è
 * pigra (al primo accesso) per non rompere la build senza variabili.
 */
export const publicEnv = {
  get NEXT_PUBLIC_SUPABASE_URL(): string {
    return requirePublic("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get NEXT_PUBLIC_SUPABASE_ANON_KEY(): string {
    return requirePublic("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
};
