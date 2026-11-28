"use client";

import { useState } from "react";
import { MAX_MESSAGE_CHARS } from "@/lib/agent/limits";

export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");

  return (
    <form
      className="sticky bottom-0 border-t border-[#E3E6EB] bg-white px-4 py-4 sm:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value || disabled) return;
        onSend(value);
        setText("");
      }}
    >
      <div className="mx-auto flex max-w-[860px] items-center gap-2.5">
        <label htmlFor="msg" className="sr-only">
          Messaggio all&apos;assistente
        </label>
        <input
          id="msg"
          type="text"
          autoComplete="off"
          maxLength={MAX_MESSAGE_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Chiedi una riunione o un orario libero…"
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-[#CBD1DA] bg-white px-4 text-[15px] focus:border-[#1F4FC7] focus:outline-2 focus:outline-[#1F4FC7]/30"
        />
        <button
          type="submit"
          aria-label="Invia"
          disabled={disabled || text.trim() === ""}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#1F4FC7] text-white hover:bg-[#163B96] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </form>
  );
}
