import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText } from "ai";
import type { NextRequest } from "next/server";
import { MAX_BODY_CHARS, parseChatBody } from "@/lib/agent/chat-body";
import { CONVERSATION_HEADER } from "@/lib/agent/limits";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import { buildTools, type ChatMessage } from "@/lib/agent/tools";
import { getApiUser } from "@/lib/auth/session";
import { CHAT_MESSAGE_ACTION, ConversationNotFoundError } from "@/lib/db/repo";
import { serverEnv } from "@/lib/env";
import { forbidden, isSameOrigin, jsonError, unauthorized } from "@/lib/http/api";
import { createRequestDeps } from "@/lib/requests/deps";

export const maxDuration = 60;

const MODEL = "claude-sonnet-5-5";
const MAX_STEPS = 8;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MSG_RATE_LIMIT = "Troppi messaggi, riprova tra qualche minuto.";
const MSG_STREAM_ERROR = "Si è verificato un errore con l'assistente, riprova.";

export async function POST(request: NextRequest) {
  const user = await getApiUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden();

  // Rifiuta i corpi enormi prima di leggerli (4 byte per carattere UTF-8 al massimo).
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS * 4) return jsonError(413, "Messaggio troppo lungo.");

  const body = parseChatBody(await request.text());
  if (!body) return jsonError(400, "Messaggio non valido.");

  const deps = await createRequestDeps();
  const now = deps.now();

  const recent = await deps.repo.countUserMessagesSince(user.id, new Date(now.getTime() - RATE_WINDOW_MS));
  if (recent >= RATE_LIMIT) return jsonError(429, MSG_RATE_LIMIT);

  const tools = buildTools(deps, user);
  const validated = await safeValidateUIMessages<ChatMessage>({ messages: body.history, tools });
  if (!validated.success) return jsonError(400, "Messaggio non valido.");

  const conversationId =
    body.conversationId ??
    (await deps.repo.createConversation(user.id, body.userText.slice(0, 80))).id;
  try {
    await deps.repo.appendMessage(user.id, conversationId, "user", body.userMessage);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return jsonError(404, "Conversazione non trovata.");
    }
    throw err;
  }
  // Una riga di audit per messaggio utente: è il contatore del rate limit.
  await deps.repo.audit({
    actorId: user.id,
    actorEmail: user.email,
    action: CHAT_MESSAGE_ACTION,
    targetType: "conversation",
    targetId: conversationId,
    details: { chars: body.userText.length },
  });

  const { workHours } = await deps.repo.getSettings();
  const anthropic = createAnthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY });

  const result = streamText({
    model: anthropic(MODEL),
    system: buildSystemPrompt(now, workHours),
    messages: convertToModelMessages(validated.data, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: request.signal,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: validated.data,
    generateMessageId: () => crypto.randomUUID(),
    headers: { [CONVERSATION_HEADER]: conversationId },
    onFinish: async ({ responseMessage }) => {
      try {
        await deps.repo.appendMessage(user.id, conversationId, "assistant", responseMessage);
      } catch (err) {
        console.error("[chat] salvataggio della risposta non riuscito", err);
      }
    },
    onError: (err) => {
      console.error("[chat] errore durante la risposta", err);
      return MSG_STREAM_ERROR;
    },
  });
}
