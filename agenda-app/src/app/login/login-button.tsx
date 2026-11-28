"use client";

import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";

export function LoginButton({ domain }: { domain: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    try {
      const { error } = await createBrowserSupabase().auth.signInWithOAuth({
        provider: "google",
        options: {
          queryParams: { hd: domain, prompt: "select_account" },
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    } catch {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="flex min-h-12 w-full items-center justify-center gap-2.5 rounded-[10px] border border-[#CBD1DA] bg-white text-[15px] font-semibold text-[#14161A] hover:bg-[#F5F6F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1F4FC7] disabled:cursor-wait disabled:opacity-70"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#14161A" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7.1z" />
          <path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-2 .9-3.2.9-2.5 0-4.6-1.7-5.3-3.9H3.5v2.5A9 9 0 0 0 12 21z" />
          <path d="M6.7 13.3a5.4 5.4 0 0 1 0-3.5V7.3H3.5a9 9 0 0 0 0 8.1z" />
          <path d="M12 6.6c1.4 0 2.6.5 3.6 1.4l2.7-2.7A9 9 0 0 0 3.5 7.3l3.2 2.5C7.4 8.3 9.5 6.6 12 6.6z" />
        </svg>
        {pending ? "Reindirizzamento…" : "Accedi con Google"}
      </button>
      {failed && (
        <p role="alert" className="m-0 text-[13px] text-[#7A1E1E]">
          Impossibile avviare l&apos;accesso. Riprova.
        </p>
      )}
    </>
  );
}
