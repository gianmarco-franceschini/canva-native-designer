import type { EventRequest, Repo } from "@/lib/db/repo";
import { N8nError, type N8nClient } from "@/lib/n8n/client";
import { resolveAttendees, type ResolvedAttendees } from "@/lib/people";
import { findConflicts, type Conflict } from "@/lib/scheduling/conflicts";
import { findFreeSlots } from "@/lib/scheduling/slots";
import type { BusyByPerson, Interval } from "@/lib/scheduling/types";

export type Deps = { repo: Repo; n8n: N8nClient; now: () => Date };
export type User = { id: string; email: string; fullName: string };

const MAX_TITLE = 200;
const MAX_DURATION_MS = 8 * 60 * 60 * 1000;

export const MSG_TIMEOUT = "Il calendario non risponde, riprova tra poco.";
export const MSG_CALENDAR_ERROR = "Errore del calendario, riprova più tardi.";

type Ambiguous = ResolvedAttendees["ambiguous"];

const lower = (s: string) => s.trim().toLowerCase();

/** Risolve i nomi in email; il richiedente è sempre incluso in `all`. */
async function resolve(deps: Deps, user: User, input: string[]) {
  const colleagues = await deps.repo.listColleagues();
  const r = resolveAttendees(input, user.email, colleagues);
  return { ...r, all: [lower(user.email), ...r.emails] };
}

function auditEntry(user: User, action: string, targetId: string | null, details: Record<string, unknown> = {}) {
  return {
    actorId: user.id,
    actorEmail: user.email,
    action,
    targetType: "event_request",
    targetId,
    details,
  };
}

// ---------------------------------------------------------------- disponibilità

export async function checkAvailability(
  deps: Deps,
  user: User,
  input: { attendees: string[]; from: Date; to: Date },
): Promise<{ busy: BusyByPerson; unreadable: string[]; unknown: string[]; ambiguous: Ambiguous }> {
  const r = await resolve(deps, user, input.attendees);
  if (r.unknown.length > 0 || r.ambiguous.length > 0) {
    return { busy: {}, unreadable: [], unknown: r.unknown, ambiguous: r.ambiguous };
  }
  const { busy, unreadable } = await deps.n8n.freeBusy(r.all, input.from, input.to);
  await deps.repo.audit(
    auditEntry(user, "availability_checked", null, { people: r.all.length }),
  );
  return { busy, unreadable, unknown: [], ambiguous: [] };
}

export async function suggestSlots(
  deps: Deps,
  user: User,
  input: { attendees: string[]; durationMinutes: number; from: Date; to: Date },
): Promise<{ slots: Interval[]; unreadable: string[]; unknown: string[]; ambiguous: Ambiguous }> {
  const r = await resolve(deps, user, input.attendees);
  if (r.unknown.length > 0 || r.ambiguous.length > 0) {
    return { slots: [], unreadable: [], unknown: r.unknown, ambiguous: r.ambiguous };
  }
  const { busy, unreadable } = await deps.n8n.freeBusy(r.all, input.from, input.to);
  const { workHours, closures } = await deps.repo.getSettings();
  const slots = findFreeSlots({
    busy,
    from: input.from,
    to: input.to,
    durationMinutes: input.durationMinutes,
    workHours,
    closures,
    now: deps.now(),
  });
  await deps.repo.audit(
    auditEntry(user, "availability_checked", null, { people: r.all.length, suggest: true }),
  );
  return { slots, unreadable, unknown: [], ambiguous: [] };
}

// ------------------------------------------------------------------- proposta

export type ProposeResult =
  | {
      status: "proposed";
      request: EventRequest;
      conflicts: Conflict[];
      unreadable: string[];
    }
  | { status: "invalid_attendees"; unknown: string[]; ambiguous: Ambiguous }
  | { status: "invalid_input"; message: string };

export async function proposeEvent(
  deps: Deps,
  user: User,
  input: { title: string; description?: string; start: Date; end: Date; attendees: string[] },
): Promise<ProposeResult> {
  const title = input.title.trim();
  const invalid = (message: string): ProposeResult => ({ status: "invalid_input", message });
  if (title.length < 1 || title.length > MAX_TITLE) {
    return invalid(`Il titolo deve avere da 1 a ${MAX_TITLE} caratteri.`);
  }
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return invalid("La fine deve essere dopo l'inizio.");
  }
  if (endMs - startMs > MAX_DURATION_MS) return invalid("La durata massima è di 8 ore.");
  if (startMs < deps.now().getTime()) return invalid("L'inizio è già passato.");

  const r = await resolve(deps, user, input.attendees);
  if (r.unknown.length > 0 || r.ambiguous.length > 0) {
    return { status: "invalid_attendees", unknown: r.unknown, ambiguous: r.ambiguous };
  }
  if (r.emails.length === 0) return invalid("Serve almeno un partecipante oltre a te.");

  const { busy, unreadable } = await deps.n8n.freeBusy(r.all, input.start, input.end);
  const conflicts = findConflicts(busy, { start: input.start, end: input.end });

  const request = await deps.repo.insertRequest({
    userId: user.id,
    title,
    description: input.description?.trim() || null,
    startAt: input.start,
    endAt: input.end,
    attendeeEmails: r.emails,
    conflictSnapshot: {
      conflicts: conflicts.map((c) => ({
        email: c.email,
        start: c.start.toISOString(),
        end: c.end.toISOString(),
      })),
      unreadable,
    },
  });
  await deps.repo.audit(
    auditEntry(user, "event_proposed", request.id, {
      attendees: r.emails.length,
      conflicts: conflicts.length,
    }),
  );
  return { status: "proposed", request, conflicts, unreadable };
}

// ------------------------------------------------------------------- conferma

export type ConfirmResult =
  | { status: "confirmed"; htmlLink: string }
  | { status: "conflict"; conflicts: Conflict[] }
  | { status: "error"; message: string };

export async function confirmRequest(
  deps: Deps,
  user: User,
  id: string,
  allowConflict: boolean,
): Promise<ConfirmResult> {
  const error = (message: string): ConfirmResult => ({ status: "error", message });

  const req = await deps.repo.getRequest(id, user.id);
  if (!req) return error("Richiesta non trovata.");
  if (req.startAt.getTime() < deps.now().getTime()) return error("Impossibile confermare: orario già passato.");

  // Unico punto che impedisce il doppio invio: transizione atomica pending → confirming.
  const locked = await deps.repo.transitionRequest(id, user.id, "pending", "confirming");
  if (!locked) {
    const current = await deps.repo.getRequest(id, user.id);
    if (current?.status === "confirming") return error("Richiesta già in conferma.");
    if (current?.status === "confirmed") return error("Richiesta già confermata.");
    return error("La richiesta non è più confermabile.");
  }

  try {
    const res = await deps.n8n.createEvent({
      requestId: locked.id,
      title: locked.title,
      description: locked.description ?? "",
      start: locked.startAt,
      end: locked.endAt,
      organizerEmail: user.email,
      attendeeEmails: locked.attendeeEmails,
      allowConflict,
    });

    if (res.status === "conflict") {
      await deps.repo.transitionRequest(id, user.id, "confirming", "pending");
      return {
        status: "conflict",
        conflicts: findConflicts(res.busy, { start: locked.startAt, end: locked.endAt }),
      };
    }

    await deps.repo.transitionRequest(id, user.id, "confirming", "confirmed", {
      googleEventId: res.eventId,
      googleEventLink: res.htmlLink,
      confirmedAt: deps.now(),
      error: null,
    });
    const hadConflict = allowConflict && hasStoredConflicts(locked.conflictSnapshot);
    await deps.repo.audit(
      auditEntry(
        user,
        allowConflict ? "event_confirmed_with_conflict" : "event_confirmed",
        id,
        { allowConflict, hadConflict },
      ),
    );
    return { status: "confirmed", htmlLink: res.htmlLink };
  } catch (err) {
    const message = err instanceof N8nError && err.kind === "timeout" ? MSG_TIMEOUT : MSG_CALENDAR_ERROR;
    await deps.repo.transitionRequest(id, user.id, "confirming", "failed", { error: message });
    await deps.repo.audit(
      auditEntry(user, "event_failed", id, {
        phase: "confirm",
        kind: err instanceof N8nError ? err.kind : "unexpected",
      }),
    );
    return error(message);
  }
}

function hasStoredConflicts(snapshot: unknown): boolean {
  const c = (snapshot as { conflicts?: unknown } | null)?.conflicts;
  return Array.isArray(c) && c.length > 0;
}

// ----------------------------------------------------------------- annullamento

export type CancelResult = { status: "cancelled" } | { status: "error"; message: string };

export async function cancelRequest(deps: Deps, user: User, id: string): Promise<CancelResult> {
  const error = (message: string): CancelResult => ({ status: "error", message });

  const req = await deps.repo.getRequest(id, user.id);
  if (!req) return error("Richiesta non trovata.");

  if (req.status === "pending") {
    const done = await deps.repo.transitionRequest(id, user.id, "pending", "cancelled");
    if (!done) return error("La richiesta non è più annullabile.");
  } else if (req.status === "confirmed") {
    if (!req.googleEventId) return error("Evento Google non trovato per questa richiesta.");
    try {
      await deps.n8n.cancelEvent({ requestId: id, googleEventId: req.googleEventId });
    } catch (err) {
      await deps.repo.audit(
        auditEntry(user, "event_failed", id, {
          phase: "cancel",
          kind: err instanceof N8nError ? err.kind : "unexpected",
        }),
      );
      return error(err instanceof N8nError && err.kind === "timeout" ? MSG_TIMEOUT : MSG_CALENDAR_ERROR);
    }
    const done = await deps.repo.transitionRequest(id, user.id, "confirmed", "cancelled");
    if (!done) return error("La richiesta non è più annullabile.");
  } else {
    return error("La richiesta non è annullabile in questo stato.");
  }

  await deps.repo.audit(auditEntry(user, "event_cancelled", id, { from: req.status }));
  return { status: "cancelled" };
}
