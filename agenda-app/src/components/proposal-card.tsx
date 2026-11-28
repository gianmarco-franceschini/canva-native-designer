"use client";

import { useRef, useState } from "react";
import { formatDay, formatRange, formatTime, sameRomeDay } from "@/components/chat/format";
import type { Proposal } from "@/lib/agent/tools";

type Conflict = { email: string; start: string; end: string };

type CardState =
  | { kind: "open"; conflicts: Conflict[] }
  | { kind: "confirmed"; htmlLink: string | null }
  | { kind: "cancelled" };

const MSG_NETWORK = "Impossibile contattare il server, riprova.";
const MSG_SESSION = "Sessione scaduta: ricarica la pagina e accedi di nuovo.";
const MSG_GENERIC = "Operazione non riuscita, riprova.";

/** Solo link https a Google Calendar diventano cliccabili. */
function safeCalendarLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && /(^|\.)google\.com$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

type ApiResult =
  | { status: "confirmed"; htmlLink?: unknown }
  | { status: "cancelled" }
  | { status: "conflict"; conflicts: Conflict[] }
  | { status: "error"; message: string };

async function post(url: string, body?: unknown): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return { status: "error", message: MSG_NETWORK };
  }
  if (res.status === 401) return { status: "error", message: MSG_SESSION };
  const data = (await res.json().catch(() => null)) as Partial<ApiResult> & { message?: string };
  if (data?.status === "confirmed" || data?.status === "cancelled") return data as ApiResult;
  if (data?.status === "conflict" && Array.isArray(data.conflicts)) return data as ApiResult;
  return {
    status: "error",
    message: typeof data?.message === "string" ? data.message : MSG_GENERIC,
  };
}

export function ProposalCard({ proposal, userEmail }: { proposal: Proposal; userEmail: string }) {
  const [state, setState] = useState<CardState>({ kind: "open", conflicts: proposal.conflicts });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Il ref blocca anche i doppi clic che arrivano prima del re-render.
  const inFlight = useRef(false);

  const me = userEmail.toLowerCase();
  const names = new Map(proposal.attendees.map((a) => [a.email.toLowerCase(), a.name]));
  const nameOf = (email: string) => (email.toLowerCase() === me ? "Tu" : (names.get(email.toLowerCase()) ?? email));
  const unreadable = new Set(proposal.unreadable.map((e) => e.toLowerCase()));
  const base = `/api/requests/${encodeURIComponent(proposal.requestId)}`;

  async function run(action: "confirm" | "cancel", allowConflict = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r =
        action === "confirm"
          ? await post(`${base}/confirm`, { allowConflict })
          : await post(`${base}/cancel`);
      if (r.status === "confirmed") setState({ kind: "confirmed", htmlLink: safeCalendarLink(r.htmlLink) });
      else if (r.status === "cancelled") setState({ kind: "cancelled" });
      else if (r.status === "conflict") {
        setState({ kind: "open", conflicts: r.conflicts });
        setError("Nel frattempo è comparso un conflitto: controlla e conferma di nuovo se vuoi procedere.");
      } else setError(r.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const when = formatRange(proposal.start, proposal.end);
  const people = ["Tu", ...proposal.attendees.map((a) => a.name)].join(", ");
  const conflicts = state.kind === "open" ? state.conflicts : [];
  const unreadableLine = (email: string) =>
    `Il calendario di ${nameOf(email)} non è leggibile: è considerato occupato.`;
  const conflictLine = (c: Conflict) => {
    const sameDay = sameRomeDay(c.start, proposal.start) && sameRomeDay(c.end, proposal.start);
    const range = sameDay
      ? `dalle ${formatTime(c.start)} alle ${formatTime(c.end)}`
      : `da ${formatDay(c.start)} ${formatTime(c.start)} a ${formatDay(c.end)} ${formatTime(c.end)}`;
    return c.email.toLowerCase() === me
      ? `Hai già un impegno ${range}.`
      : `${nameOf(c.email)} ha un impegno ${range}.`;
  };
  // Un calendario illeggibile risulta occupato per tutto l'intervallo: una sola riga dedicata.
  const conflictLines = [
    ...conflicts.filter((c) => !unreadable.has(c.email.toLowerCase())).map(conflictLine),
    ...[...unreadable].map(unreadableLine),
  ];
  const conflictPeople = new Set([...conflicts.map((c) => c.email.toLowerCase()), ...unreadable]);
  const hasConflicts = state.kind === "open" && conflictPeople.size > 0;
  const conflictCount = conflictPeople.size;

  const tone =
    state.kind === "confirmed"
      ? "border-[#B9DFC8]"
      : hasConflicts
        ? "border-[#F0C9A8]"
        : "border-[#E3E6EB]";

  return (
    <section
      aria-label={hasConflicts ? "Proposta con conflitto" : "Proposta di riunione"}
      aria-busy={busy}
      className={`flex flex-col gap-4 rounded-[14px] border bg-white p-5 shadow-[0_1px_2px_rgba(20,22,26,0.06)] ${tone}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-[#5B626D]">Proposta</div>
          <div className="mt-1 text-lg font-semibold">{proposal.title}</div>
        </div>
        <StatusBadge state={state} hasConflicts={hasConflicts} conflictCount={conflictCount} />
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-[#5B626D]">Quando</div>
          <div className="mt-0.5 font-medium">{when}</div>
        </div>
        <div>
          <div className="text-[#5B626D]">Partecipanti</div>
          <div className="mt-0.5 font-medium">{people}</div>
        </div>
      </div>

      {hasConflicts && (
        <div className="rounded-[10px] bg-[#FDF5EE] px-3.5 py-3 text-sm leading-normal text-[#5E2F09]">
          {conflictLines.map((line, i) => (
            <p key={i} className="m-0">
              {line}
            </p>
          ))}
          <p className="m-0 mt-1">Se confermi, la riunione si sovrapporrà a questi impegni.</p>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-[10px] border border-[#EFC3C3] bg-[#FCEDED] px-3.5 py-3 text-sm text-[#7A1E1E]">
          {error}
        </div>
      )}

      {state.kind === "open" && (
        <>
          <div className="flex flex-wrap gap-2.5 border-t border-[#EEF0F3] pt-4">
            {hasConflicts ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("confirm", true)}
                className="min-h-11 rounded-[10px] border border-[#B85A14] bg-white px-5 text-[15px] font-semibold text-[#8A420C] hover:bg-[#FDF5EE] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Conferma comunque
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("confirm", false)}
                className="min-h-11 rounded-[10px] bg-[#1F4FC7] px-5 text-[15px] font-semibold text-white hover:bg-[#163B96] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Conferma e invia inviti
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => run("cancel")}
              className="min-h-11 rounded-[10px] border border-[#CBD1DA] bg-white px-5 text-[15px] text-[#14161A] hover:bg-[#F5F6F8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Annulla
            </button>
          </div>
          <p className="m-0 text-[13px] text-[#5B626D]" aria-live="polite">
            {busy ? "Operazione in corso…" : "Nulla viene scritto sul calendario finché non confermi."}
          </p>
        </>
      )}

      {state.kind === "confirmed" && (
        <p className="m-0 text-sm text-[#17663A]" role="status">
          Riunione creata e inviti inviati.{" "}
          {state.htmlLink && (
            <a href={state.htmlLink} target="_blank" rel="noopener noreferrer" className="font-semibold">
              Apri in Google Calendar
            </a>
          )}
        </p>
      )}

      {state.kind === "cancelled" && (
        <p className="m-0 text-sm text-[#5B626D]" role="status">
          Proposta annullata. Nessun evento è stato creato.
        </p>
      )}
    </section>
  );
}

function StatusBadge({
  state,
  hasConflicts,
  conflictCount,
}: {
  state: CardState;
  hasConflicts: boolean;
  conflictCount: number;
}) {
  const pill = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] font-semibold";
  const check = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
  if (state.kind === "confirmed") return <span className={`${pill} bg-[#E6F4EC] text-[#17663A]`}>{check}Confermata</span>;
  if (state.kind === "cancelled") return <span className={`${pill} bg-[#EEF0F3] text-[#3D434D]`}>Annullata</span>;
  if (!hasConflicts) return <span className={`${pill} bg-[#E6F4EC] text-[#17663A]`}>{check}Nessun conflitto</span>;
  return (
    <span className={`${pill} bg-[#FDEEE2] text-[#9A4A0E]`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      {conflictCount === 1 ? "1 conflitto" : `${conflictCount} conflitti`}
    </span>
  );
}
