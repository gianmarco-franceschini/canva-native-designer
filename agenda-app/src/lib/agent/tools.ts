import { TZDate } from "@date-fns/tz";
import { tool, type InferUITools, type UIDataTypes, type UIMessage } from "ai";
import { z } from "zod";
import { N8nError } from "@/lib/n8n/client";
import {
  checkAvailability,
  MSG_CALENDAR_ERROR,
  MSG_TIMEOUT,
  proposeEvent,
  suggestSlots,
  type Deps,
  type User,
} from "@/lib/requests/service";
import { TIME_ZONE, type Interval } from "@/lib/scheduling/types";

/** Partecipanti oltre al richiedente (aggiunto dal server): 14 + 1 = limite FreeBusy di 15. */
export const MAX_ATTENDEES = 14;
const MAX_RANGE_DAYS = 14;
const MAX_SLOTS = 10;

const isoDate = (what: string) =>
  z.iso
    .datetime({ offset: true })
    .describe(`${what}: data e ora ISO 8601 con scostamento, es. 2026-11-27T10:00:00+01:00`);

const attendees = (min: number) =>
  z
    .array(z.string().trim().min(1).max(200))
    .min(min)
    .max(MAX_ATTENDEES)
    .describe(
      `Nomi (nome e cognome o solo nome) o email aziendali dei colleghi, escluso l'utente; massimo ${MAX_ATTENDEES}`,
    );

/** ISO con lo scostamento di Roma, più leggibile per il modello rispetto a UTC. */
const romeIso = (d: Date) => new TZDate(d.getTime(), TIME_ZONE).toISOString();
const interval = (i: Interval) => ({ start: romeIso(i.start), end: romeIso(i.end) });

type ToolError = { error: string } & Record<string, unknown>;

/** Errori del calendario → messaggio per l'utente; tutto il resto resta un'eccezione. */
async function calendarSafe<T>(fn: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof N8nError) {
      return { error: err.kind === "timeout" ? MSG_TIMEOUT : MSG_CALENDAR_ERROR };
    }
    throw err;
  }
}

function checkRange(from: Date, to: Date): ToolError | null {
  if (to.getTime() <= from.getTime()) return { error: "La fine dell'intervallo deve essere dopo l'inizio." };
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { error: `L'intervallo massimo è di ${MAX_RANGE_DAYS} giorni.` };
  }
  return null;
}

function attendeeError(
  unknown: string[],
  ambiguous: { input: string; options: string[] }[],
): ToolError | null {
  if (unknown.length === 0 && ambiguous.length === 0) return null;
  return {
    error:
      "Alcuni partecipanti non sono stati riconosciuti: chiedi all'utente di chiarire (solo colleghi della rubrica aziendale).",
    unknown,
    ambiguous,
  };
}

/**
 * Strumenti dell'assistente. Nessuno crea eventi: `propose_event` registra solo una
 * proposta in attesa, che l'utente conferma col pulsante (POST /api/requests/:id/confirm).
 * Le uscite contengono solo libero/occupato, mai titoli o dettagli di impegni altrui.
 */
export function buildTools(deps: Deps, user: User) {
  return {
    list_colleagues: tool({
      description:
        "Elenca i colleghi attivi della rubrica aziendale (nome ed email). Usalo per riconoscere i nomi citati dall'utente.",
      inputSchema: z.object({}),
      execute: async () => {
        const list = await deps.repo.listColleagues();
        return { colleagues: list.map((c) => ({ name: c.fullName, email: c.email })) };
      },
    }),

    check_availability: tool({
      description:
        "Restituisce gli intervalli occupati (senza dettagli) dell'utente e dei colleghi indicati in un intervallo di massimo 14 giorni. Un calendario in `unreadable` va considerato occupato.",
      inputSchema: z.object({
        attendees: attendees(1),
        from: isoDate("Inizio intervallo"),
        to: isoDate("Fine intervallo"),
      }),
      execute: async (input) => {
        const from = new Date(input.from);
        const to = new Date(input.to);
        const bad = checkRange(from, to);
        if (bad) return bad;
        return calendarSafe(async () => {
          const r = await checkAvailability(deps, user, { attendees: input.attendees, from, to });
          const invalid = attendeeError(r.unknown, r.ambiguous);
          if (invalid) return invalid;
          return {
            busy: Object.fromEntries(
              Object.entries(r.busy).map(([email, list]) => [email, list.map(interval)]),
            ),
            unreadable: r.unreadable,
          };
        });
      },
    }),

    find_free_slots: tool({
      description: `Trova fino a ${MAX_SLOTS} orari liberi per tutti (utente incluso) della durata indicata, entro l'orario lavorativo, escluse festività e chiusure.`,
      inputSchema: z.object({
        attendees: attendees(0),
        durationMinutes: z
          .number()
          .int()
          .min(15)
          .max(480)
          .describe("Durata della riunione in minuti (15–480)"),
        from: isoDate("Inizio intervallo di ricerca"),
        to: isoDate("Fine intervallo di ricerca"),
      }),
      execute: async (input) => {
        const from = new Date(input.from);
        const to = new Date(input.to);
        const bad = checkRange(from, to);
        if (bad) return bad;
        return calendarSafe(async () => {
          const r = await suggestSlots(deps, user, {
            attendees: input.attendees,
            durationMinutes: input.durationMinutes,
            from,
            to,
          });
          const invalid = attendeeError(r.unknown, r.ambiguous);
          if (invalid) return invalid;
          return { slots: r.slots.slice(0, MAX_SLOTS).map(interval), unreadable: r.unreadable };
        });
      },
    }),

    propose_event: tool({
      description:
        "Prepara una proposta di riunione (non crea l'evento). L'utente vedrà una scheda con i conflitti e potrà confermarla o annullarla col pulsante.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(200).describe("Titolo della riunione"),
        description: z.string().max(2000).optional().describe("Descrizione facoltativa"),
        start: isoDate("Inizio"),
        end: isoDate("Fine"),
        attendees: attendees(1),
      }),
      execute: async (input) =>
        calendarSafe(async () => {
          const r = await proposeEvent(deps, user, {
            title: input.title,
            description: input.description,
            start: new Date(input.start),
            end: new Date(input.end),
            attendees: input.attendees,
          });
          if (r.status === "invalid_input") return { error: r.message };
          if (r.status === "invalid_attendees") {
            return attendeeError(r.unknown, r.ambiguous) as ToolError;
          }
          const names = new Map(
            (await deps.repo.listColleagues()).map((c) => [c.email.toLowerCase(), c.fullName]),
          );
          const nameOf = (email: string) => names.get(email.toLowerCase()) ?? email;
          return {
            requestId: r.request.id,
            title: r.request.title,
            start: romeIso(r.request.startAt),
            end: romeIso(r.request.endAt),
            attendees: r.request.attendeeEmails.map((email) => ({ email, name: nameOf(email) })),
            conflicts: r.conflicts.map((c) => ({
              email: c.email,
              name: nameOf(c.email),
              ...interval(c),
            })),
            unreadable: r.unreadable,
          };
        }),
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;

/** Messaggio di chat tipizzato con gli strumenti dell'assistente (server e client). */
export type ChatMessage = UIMessage<never, UIDataTypes, InferUITools<AgentTools>>;
/** Uscita di `propose_event` andata a buon fine. */
export type Proposal = Exclude<
  Awaited<ReturnType<NonNullable<AgentTools["propose_event"]["execute"]>>>,
  ToolError | AsyncIterable<unknown>
>;
