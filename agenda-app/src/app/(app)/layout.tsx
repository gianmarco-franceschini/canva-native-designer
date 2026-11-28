import { AppNav } from "@/components/app-nav";
import { requireUser } from "@/lib/auth/session";

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-screen flex-col bg-[#F5F6F8] text-[#14161A]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E3E6EB] bg-white px-4 py-4 sm:px-8">
        <div className="flex items-center gap-2.5 text-lg font-bold">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1F4FC7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          Agenda
        </div>
        <AppNav isAdmin={user.role === "admin"} />
        <div className="flex items-center gap-2.5 text-sm text-[#3D434D]">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#DDE5F7] font-semibold text-[#1F4FC7]"
          >
            {initials(user.fullName)}
          </span>
          {user.fullName}
        </div>
      </header>
      {children}
    </div>
  );
}
