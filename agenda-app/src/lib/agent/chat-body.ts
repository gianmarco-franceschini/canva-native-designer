import { z } from "zod";
import { HISTORY_LIMIT, MAX_MESSAGE_CHARS } from "./limits";

export { HISTORY_LIMIT, MAX_MESSAGE_CHARS };
/** Tetto al corpo grezzo della richiesta (cronologia compresa). */
export const MAX_BODY_CHARS = 200_000;

const id = z.string().min(1).max(200);

const userMessage = z.object({
  id,
  role: z.literal("user"),
  parts: z
    .array(z.object({ type: z.literal("text"), text: z.string().max(MAX_MESSAGE_CHARS) }))
    .min(1)
    .max(10),
});

// Le parti dell'assistente (testo, step, chiamate agli strumenti) sono convalidate in
// dettaglio da `validateUIMessages` con gli schemi degli strumenti; qui solo la forma.
const assistantMessage = z.object({
  id,
  role: z.literal("assistant"),
  parts: z.array(z.looseObject({ type: z.string().max(100) })).max(100),
});

const bodySchema = z.object({
  conversationId: z.uuid().nullish(),
  messages: z.array(z.discriminatedUnion("role", [userMessage, assistantMessage])).min(1).max(200),
});

export type ChatBody = {
  conversationId: string | null;
  /** Ultimi `HISTORY_LIMIT` messaggi, a partire da un messaggio dell'utente. */
  history: z.infer<typeof bodySchema>["messages"];
  /** Il nuovo messaggio dell'utente (l'ultimo della cronologia). */
  userMessage: z.infer<typeof userMessage>;
  userText: string;
};

/** Convalida il corpo di POST /api/chat; null se non valido. */
export function parseChatBody(raw: string): ChatBody | null {
  if (raw.length > MAX_BODY_CHARS) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return null;

  const all = parsed.data.messages;
  const last = all[all.length - 1];
  if (last.role !== "user") return null;
  const userText = last.parts.map((p) => p.text).join("\n").trim();
  if (!userText || userText.length > MAX_MESSAGE_CHARS) return null;

  let history = all.slice(-HISTORY_LIMIT);
  const firstUser = history.findIndex((m) => m.role === "user");
  history = history.slice(firstUser);

  return {
    conversationId: parsed.data.conversationId ?? null,
    history,
    userMessage: last,
    userText,
  };
}
