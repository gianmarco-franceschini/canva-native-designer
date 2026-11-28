import { z } from "zod";
import type { BusyByPerson, Interval } from "../scheduling/types";
import { signRequest } from "./sign";

export class N8nError extends Error {
  readonly kind: "timeout" | "http" | "invalid_response";
  constructor(kind: "timeout" | "http" | "invalid_response", message: string) {
    super(message);
    this.name = "N8nError";
    this.kind = kind;
  }
}

export type CreateEventInput = {
  requestId: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  organizerEmail: string;
  attendeeEmails: string[];
  allowConflict: boolean;
};

export type CreateEventResult =
  | { status: "created"; eventId: string; htmlLink: string }
  | { status: "conflict"; busy: BusyByPerson };

export type N8nClient = {
  freeBusy(
    emails: string[],
    from: Date,
    to: Date,
  ): Promise<{ busy: BusyByPerson; unreadable: string[] }>;
  createEvent(input: CreateEventInput): Promise<CreateEventResult>;
  cancelEvent(input: { requestId: string; googleEventId: string }): Promise<{ status: "cancelled" }>;
};

const MAX_EMAILS = 15;
const MAX_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

const dateStr = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");
const intervalSchema = z.object({ start: dateStr, end: dateStr });

const freeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(intervalSchema).optional(),
      errors: z.array(z.unknown()).optional(),
      error: z.unknown().optional(),
    }),
  ),
});

const createSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), eventId: z.string(), htmlLink: z.string() }),
  z.object({ status: z.literal("conflict"), busy: z.record(z.string(), z.array(intervalSchema)) }),
]);

const cancelSchema = z.object({ status: z.literal("cancelled") });

function toIntervals(list: { start: string; end: string }[]): Interval[] {
  return list.map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
}

function normalizeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

export function createN8nClient(opts: {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): N8nClient {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  async function post<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const rawBody = JSON.stringify(payload);
    const ts = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchFn(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Timestamp": String(ts),
            "X-Signature": signRequest(rawBody, opts.secret, ts),
          },
          body: rawBody,
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut || (err instanceof Error && err.name === "AbortError")) {
          throw new N8nError("timeout", `n8n non ha risposto entro ${timeoutMs} ms`);
        }
        throw new N8nError("http", "Errore di rete nella chiamata a n8n");
      }
      if (!res.ok) {
        throw new N8nError("http", `n8n ha risposto con HTTP ${res.status}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        if (timedOut || (err instanceof Error && err.name === "AbortError")) {
          throw new N8nError("timeout", `n8n non ha risposto entro ${timeoutMs} ms`);
        }
        throw new N8nError("invalid_response", "Risposta n8n non è JSON valido");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new N8nError("invalid_response", "Risposta n8n non conforme allo schema");
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async freeBusy(emails, from, to) {
      const list = normalizeEmails(emails);
      if (list.length === 0) throw new Error("Nessuna email da controllare");
      if (list.length > MAX_EMAILS) throw new Error(`Massimo ${MAX_EMAILS} email per richiesta`);
      const range = to.getTime() - from.getTime();
      if (!(range > 0)) throw new Error("Intervallo non valido");
      if (range > MAX_RANGE_MS) throw new Error("Intervallo massimo di 14 giorni superato");

      const data = await post(
        "/webhook/agenda-freebusy",
        { emails: list, timeMin: from.toISOString(), timeMax: to.toISOString() },
        freeBusySchema,
      );

      const busy: BusyByPerson = {};
      const unreadable: string[] = [];
      const calendars: Record<string, (typeof data.calendars)[string]> = {};
      for (const [k, v] of Object.entries(data.calendars)) calendars[k.toLowerCase()] = v;
      for (const email of list) {
        const cal = calendars[email];
        const failed =
          !cal || cal.error != null || (cal.errors != null && cal.errors.length > 0);
        if (failed) {
          // Errore di lettura = occupato per tutto l'intervallo, mai libero.
          unreadable.push(email);
          busy[email] = [{ start: new Date(from), end: new Date(to) }];
        } else {
          busy[email] = toIntervals(cal.busy ?? []);
        }
      }
      return { busy, unreadable };
    },

    async createEvent(input) {
      const organizerEmail = input.organizerEmail.trim().toLowerCase();
      const attendeeEmails = normalizeEmails(input.attendeeEmails);
      if (!organizerEmail) throw new Error("Email organizzatore mancante");
      if (attendeeEmails.length === 0) throw new Error("Nessun partecipante");
      const data = await post(
        "/webhook/agenda-create-event",
        {
          requestId: input.requestId,
          title: input.title,
          description: input.description,
          start: input.start.toISOString(),
          end: input.end.toISOString(),
          organizerEmail,
          attendeeEmails,
          allowConflict: input.allowConflict,
        },
        createSchema,
      );
      if (data.status === "created") return data;
      const busy: BusyByPerson = {};
      for (const [email, list] of Object.entries(data.busy)) busy[email] = toIntervals(list);
      return { status: "conflict", busy };
    },

    async cancelEvent(input) {
      return post(
        "/webhook/agenda-cancel-event",
        { requestId: input.requestId, googleEventId: input.googleEventId },
        cancelSchema,
      );
    },
  };
}
