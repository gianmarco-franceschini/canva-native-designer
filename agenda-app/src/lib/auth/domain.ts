/**
 * Regole di appartenenza al dominio aziendale. Funzioni pure, senza dipendenze dal
 * runtime: usate dal callback OAuth e da `requireUser`.
 */

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Vero solo se `email` ha esattamente una `@`, una parte locale non vuota, nessuno spazio
 * e un dominio identico a `domain` (non un suffisso: `x@evil-example.com`,
 * `x@sub.example.com` e `x@example.com.evil` sono rifiutati). Confronto case-insensitive.
 */
export function isAllowedEmail(email: string | undefined, domain: string): boolean {
  const wanted = normalizeDomain(domain);
  if (!email || !wanted || /\s/.test(email)) return false;
  const parts = email.toLowerCase().split("@");
  if (parts.length !== 2) return false;
  const [local, host] = parts;
  return local.length > 0 && host === wanted;
}

/** Forma minima dell'utente Supabase che serve al controllo (compatibile con `User`). */
export type GoogleUserLike = {
  email?: string;
  app_metadata?: { provider?: unknown };
  user_metadata?: { custom_claims?: { hd?: unknown } };
};

/**
 * Utente ammesso al login: provider Supabase `google`, email nel dominio e claim Google
 * `hd` (dominio Workspace, salvato da Supabase in `user_metadata.custom_claims.hd`)
 * identico al dominio configurato. Un account Google personale non ha `hd`: rifiutato.
 */
export function isAllowedGoogleUser(user: GoogleUserLike, domain: string): boolean {
  const wanted = normalizeDomain(domain);
  const hd = user.user_metadata?.custom_claims?.hd;
  return (
    user.app_metadata?.provider === "google" &&
    typeof hd === "string" &&
    hd === wanted &&
    isAllowedEmail(user.email, wanted)
  );
}
