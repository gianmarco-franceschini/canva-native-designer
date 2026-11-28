export type Colleague = { email: string; fullName: string };

export type ResolvedAttendees = {
  emails: string[];
  unknown: string[];
  ambiguous: { input: string; options: string[] }[];
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const firstName = (fullName: string) => norm(fullName).split(" ")[0] ?? "";

/**
 * Converte email o nomi (nome intero o nome di battesimo, case-insensitive) in email
 * della rubrica. Il richiedente e i duplicati vengono rimossi; chi non è nella rubrica
 * attiva (esterni, disattivati, nomi ignoti) finisce in `unknown`.
 */
export function resolveAttendees(
  input: string[],
  requesterEmail: string,
  colleagues: Colleague[],
): ResolvedAttendees {
  const requester = norm(requesterEmail);
  const emails: string[] = [];
  const unknown: string[] = [];
  const ambiguous: ResolvedAttendees["ambiguous"] = [];

  const add = (email: string) => {
    if (email !== requester && !emails.includes(email)) emails.push(email);
  };

  for (const raw of input) {
    const q = norm(raw);
    if (!q) continue;

    if (q.includes("@")) {
      const hit = colleagues.find((c) => norm(c.email) === q);
      if (hit) add(norm(hit.email));
      else if (q !== requester) unknown.push(raw.trim());
      continue;
    }

    let matches = colleagues.filter((c) => norm(c.fullName) === q);
    if (matches.length === 0) matches = colleagues.filter((c) => firstName(c.fullName) === q);
    const found = matches.map((c) => norm(c.email));
    const others = found.filter((e) => e !== requester);

    if (found.length === 0) unknown.push(raw.trim());
    else if (others.length === 1) add(others[0]);
    else if (others.length > 1) ambiguous.push({ input: raw.trim(), options: others });
    // solo il richiedente: ignorato
  }

  return { emails, unknown, ambiguous };
}
