import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { WorkHours } from "@/lib/scheduling/types";
import type { Database, Json } from "./types";

export type RequestStatus = "pending" | "confirming" | "confirmed" | "cancelled" | "failed";

export type EventRequest = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date;
  attendeeEmails: string[];
  status: RequestStatus;
  conflictSnapshot: unknown;
  googleEventId: string | null;
  googleEventLink: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  error: string | null;
};

export type NewRequest = Pick<
  EventRequest,
  "userId" | "title" | "description" | "startAt" | "endAt" | "attendeeEmails" | "conflictSnapshot"
>;

export type AuditEntry = {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
};

export type MessageRole = "user" | "assistant" | "tool";

export type Conversation = { id: string; userId: string; title: string | null; createdAt: Date };

/** Azione di audit registrata per ogni messaggio utente in chat: base del rate limit. */
export const CHAT_MESSAGE_ACTION = "chat_message";

export type Repo = {
  listColleagues(): Promise<{ email: string; fullName: string }[]>;
  getSettings(): Promise<{ workHours: WorkHours; closures: string[] }>;
  insertRequest(r: NewRequest): Promise<EventRequest>;
  getRequest(id: string, userId: string): Promise<EventRequest | null>;
  /** UPDATE ... WHERE id AND user_id AND status = from RETURNING; null se nessuna riga. */
  transitionRequest(
    id: string,
    userId: string,
    from: RequestStatus,
    to: RequestStatus,
    patch?: Partial<EventRequest>,
  ): Promise<EventRequest | null>;
  createConversation(userId: string, title: string | null): Promise<Conversation>;
  /** Lancia se la conversation non appartiene a `userId`. */
  appendMessage(
    userId: string,
    conversationId: string,
    role: MessageRole,
    content: unknown,
  ): Promise<void>;
  /**
   * Conta le righe di audit_log con action `CHAT_MESSAGE_ACTION` e actor_id = userId da
   * `since` in poi (append-only: non azzerabile dall'utente). Chi gestisce la chat deve
   * scrivere quella riga di audit per ogni messaggio utente.
   */
  countUserMessagesSince(userId: string, since: Date): Promise<number>;
  audit(entry: AuditEntry): Promise<void>;
};

export type DbClient = SupabaseClient<Database>;
type RequestRow = Database["public"]["Tables"]["event_requests"]["Row"];
type RequestUpdate = Database["public"]["Tables"]["event_requests"]["Update"];

const workHoursSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)),
  ranges: z.array(z.object({ from: z.string(), to: z.string() })),
});

export function rowToRequest(row: RequestRow): EventRequest {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    startAt: new Date(row.start_at),
    endAt: new Date(row.end_at),
    attendeeEmails: row.attendee_emails,
    status: row.status as RequestStatus,
    conflictSnapshot: row.conflict_snapshot,
    googleEventId: row.google_event_id,
    googleEventLink: row.google_event_link,
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    error: row.error,
  };
}

/** Solo i campi modificabili: id, userId, status e createdAt non passano mai da `patch`. */
function patchToRow(patch: Partial<EventRequest>): RequestUpdate {
  const row: RequestUpdate = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.startAt !== undefined) row.start_at = patch.startAt.toISOString();
  if (patch.endAt !== undefined) row.end_at = patch.endAt.toISOString();
  if (patch.attendeeEmails !== undefined) row.attendee_emails = patch.attendeeEmails;
  if (patch.conflictSnapshot !== undefined) row.conflict_snapshot = patch.conflictSnapshot as Json;
  if (patch.googleEventId !== undefined) row.google_event_id = patch.googleEventId;
  if (patch.googleEventLink !== undefined) row.google_event_link = patch.googleEventLink;
  if (patch.confirmedAt !== undefined)
    row.confirmed_at = patch.confirmedAt ? patch.confirmedAt.toISOString() : null;
  if (patch.error !== undefined) row.error = patch.error;
  return row;
}

function fail(op: string, error: { message: string }): never {
  throw new Error(`db ${op}: ${error.message}`);
}

/**
 * `userClient` (sessione dell'utente → RLS) per le letture; `serviceClient` per tutte le
 * scritture (event_requests, conversations, messages, audit — sempre con lo `userId` dato
 * esplicitamente, perché service_role scavalca la RLS) e per il conteggio del rate limit.
 */
export function createSupabaseRepo(userClient: DbClient, serviceClient: DbClient): Repo {
  return {
    async listColleagues() {
      const { data, error } = await userClient.rpc("list_colleagues");
      if (error) fail("listColleagues", error);
      return (data ?? []).map((c) => ({ email: c.email, fullName: c.full_name }));
    },

    async getSettings() {
      const [settings, closures] = await Promise.all([
        userClient.from("app_settings").select("work_hours").eq("id", 1).maybeSingle(),
        userClient.from("closures").select("day").order("day"),
      ]);
      if (settings.error) fail("getSettings", settings.error);
      if (!settings.data) throw new Error("db getSettings: app_settings mancante");
      if (closures.error) fail("getSettings", closures.error);
      return {
        workHours: workHoursSchema.parse(settings.data.work_hours),
        closures: (closures.data ?? []).map((c) => c.day),
      };
    },

    async insertRequest(r) {
      // Scrittura via service_role (l'utente ha solo SELECT): user_id sempre esplicito.
      const { data, error } = await serviceClient
        .from("event_requests")
        .insert({
          user_id: r.userId,
          title: r.title,
          description: r.description,
          start_at: r.startAt.toISOString(),
          end_at: r.endAt.toISOString(),
          attendee_emails: r.attendeeEmails,
          conflict_snapshot: r.conflictSnapshot as Json,
        })
        .select()
        .single();
      if (error) fail("insertRequest", error);
      return rowToRequest(data);
    },

    async getRequest(id, userId) {
      const { data, error } = await userClient
        .from("event_requests")
        .select()
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("getRequest", error);
      return data ? rowToRequest(data) : null;
    },

    async transitionRequest(id, userId, from, to, patch = {}) {
      // Un solo UPDATE condizionale: la transizione riesce solo se lo stato è ancora `from`.
      // service_role scavalca la RLS, quindi il filtro su user_id è ciò che garantisce la proprietà.
      const { data, error } = await serviceClient
        .from("event_requests")
        .update({ ...patchToRow(patch), status: to })
        .eq("id", id)
        .eq("user_id", userId)
        .eq("status", from)
        .select()
        .maybeSingle();
      if (error) fail("transitionRequest", error);
      return data ? rowToRequest(data) : null;
    },

    async createConversation(userId, title) {
      const { data, error } = await serviceClient
        .from("conversations")
        .insert({ user_id: userId, title })
        .select()
        .single();
      if (error) fail("createConversation", error);
      return {
        id: data.id,
        userId: data.user_id,
        title: data.title,
        createdAt: new Date(data.created_at),
      };
    },

    async appendMessage(userId, conversationId, role, content) {
      // La proprietà delle conversations non cambia mai (nessun update), quindi il
      // controllo seguito dall'insert non ha finestre di corsa rilevanti.
      const owned = await serviceClient
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (owned.error) fail("appendMessage", owned.error);
      if (!owned.data) throw new Error("db appendMessage: conversation non trovata");
      const { error } = await serviceClient
        .from("messages")
        .insert({ conversation_id: conversationId, role, content: content as NonNullable<Json> });
      if (error) fail("appendMessage", error);
    },

    async countUserMessagesSince(userId, since) {
      const { count, error } = await serviceClient
        .from("audit_log")
        .select("id", { count: "exact", head: true })
        .eq("action", CHAT_MESSAGE_ACTION)
        .eq("actor_id", userId)
        .gte("created_at", since.toISOString());
      if (error) fail("countUserMessagesSince", error);
      return count ?? 0;
    },

    async audit(entry) {
      const { error } = await serviceClient.from("audit_log").insert({
        actor_id: entry.actorId,
        actor_email: entry.actorEmail,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        details: entry.details as { [key: string]: Json },
      });
      if (error) fail("audit", error);
    },
  };
}
