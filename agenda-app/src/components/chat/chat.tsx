"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef } from "react";
import { CONVERSATION_HEADER, HISTORY_LIMIT } from "@/lib/agent/limits";
import type { ChatMessage } from "@/lib/agent/tools";
import { Composer } from "./composer";
import { MessageView } from "./message-view";

const MSG_GENERIC = "Si è verificato un errore con l'assistente, riprova.";

/** Il server risponde agli errori con JSON `{ error }`: mostra solo quel testo. */
function errorText(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Non JSON: errore di rete o del flusso.
  }
  return MSG_GENERIC;
}

export function Chat({ userEmail, todayLabel }: { userEmail: string; todayLabel: string }) {
  const conversationId = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { conversationId: conversationId.current, messages: messages.slice(-HISTORY_LIMIT) },
        }),
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          const id = res.headers.get(CONVERSATION_HEADER);
          if (id) conversationId.current = id;
          return res;
        },
      }),
    [],
  );

  const { messages, sendMessage, status, error } = useChat<ChatMessage>({ transport });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  return (
    <>
      <main className="mx-auto box-border flex w-full max-w-[860px] flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
        <div className="text-center text-[13px] text-[#5B626D]">{todayLabel}</div>

        {messages.length === 0 && (
          <div className="self-start rounded-[16px_16px_16px_4px] border border-[#E3E6EB] bg-white px-[18px] py-3.5 text-[15px] leading-[1.55] md:max-w-[85%]">
            Ciao! Posso trovare orari liberi e preparare proposte di riunione con i colleghi.
            Prova ad esempio: «Organizza una riunione sul budget con Giulia e Marco giovedì
            mattina, un&apos;ora».
          </div>
        )}

        <div role="log" aria-live="polite" aria-relevant="additions" className="flex flex-col gap-5">
          {messages.map((m) => (
            <MessageView key={m.id} message={m} userEmail={userEmail} />
          ))}
        </div>

        {status === "submitted" && (
          <div className="self-start text-sm text-[#5B626D]" role="status">
            L&apos;assistente sta scrivendo…
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-[#EFC3C3] bg-[#FCEDED] px-4 py-3.5 text-sm leading-normal text-[#7A1E1E]"
          >
            {errorText(error)}
          </div>
        )}
        <div ref={bottom} />
      </main>

      <Composer disabled={busy} onSend={(text) => sendMessage({ text })} />
    </>
  );
}
