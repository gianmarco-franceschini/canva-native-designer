"use client";

import { ProposalCard } from "@/components/proposal-card";
import type { ChatMessage, Proposal } from "@/lib/agent/tools";

const TOOL_PROGRESS: Record<string, string> = {
  "tool-list_colleagues": "Consulto la rubrica…",
  "tool-check_availability": "Controllo i calendari…",
  "tool-find_free_slots": "Cerco orari liberi…",
  "tool-propose_event": "Preparo la proposta…",
};

function isProposal(output: unknown): output is Proposal {
  return typeof output === "object" && output !== null && "requestId" in output;
}

export function MessageView({ message, userEmail }: { message: ChatMessage; userEmail: string }) {
  if (message.role === "user") {
    const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    return (
      <div className="max-w-[75%] self-end whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-[#1F4FC7] px-[18px] py-3.5 text-[15px] leading-normal text-white">
        <span className="sr-only">Tu: </span>
        {text}
      </div>
    );
  }

  return (
    <div className="flex max-w-full flex-col gap-3 self-start md:max-w-[85%]">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return (
            <div
              key={i}
              className="whitespace-pre-wrap rounded-[16px_16px_16px_4px] border border-[#E3E6EB] bg-white px-[18px] py-3.5 text-[15px] leading-[1.55]"
            >
              <span className="sr-only">Assistente: </span>
              {part.text}
            </div>
          );
        }
        if (part.type === "tool-propose_event" && part.state === "output-available" && isProposal(part.output)) {
          return <ProposalCard key={part.toolCallId} proposal={part.output} userEmail={userEmail} />;
        }
        if (
          part.type in TOOL_PROGRESS &&
          "state" in part &&
          (part.state === "input-streaming" || part.state === "input-available")
        ) {
          return (
            <div key={i} className="text-sm text-[#5B626D]" role="status">
              {TOOL_PROGRESS[part.type]}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
