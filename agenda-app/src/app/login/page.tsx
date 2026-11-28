import type { Metadata } from "next";
import { serverEnv } from "@/lib/env";
import { LoginButton } from "./login-button";

export const metadata: Metadata = { title: "Accesso · Agenda aziendale" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const domain = serverEnv().ALLOWED_DOMAIN.trim().toLowerCase();

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F5F6F8] p-6 text-[#14161A]">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <section className="flex flex-col items-center gap-5 rounded-2xl border border-[#E3E6EB] bg-white px-8 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-[14px] bg-[#EAF0FC]">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1F4FC7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="17" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </div>
          <div>
            <h1 className="m-0 text-[26px] font-bold">Agenda aziendale</h1>
            <p className="mt-2 text-[15px] leading-normal text-[#5B626D]">
              Organizza riunioni senza sovrapposizioni, con l&apos;aiuto dell&apos;assistente.
            </p>
          </div>
          <LoginButton domain={domain} />
          <p className="m-0 text-[13px] text-[#5B626D]">
            Solo account aziendali <strong className="text-[#3D434D]">@{domain}</strong>
          </p>
        </section>

        {error === "denied" && (
          <div
            role="alert"
            className="rounded-xl border border-[#EFC3C3] bg-[#FCEDED] px-4 py-3.5 text-sm leading-normal text-[#7A1E1E]"
          >
            <strong>Accesso non consentito.</strong> Questo account non è autorizzato. Chiedi
            all&apos;amministratore di aggiungerti.
          </div>
        )}
      </div>
    </main>
  );
}
