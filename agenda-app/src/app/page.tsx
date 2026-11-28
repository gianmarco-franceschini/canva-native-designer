import { requireUser } from "@/lib/auth/session";

export default async function Home() {
  const user = await requireUser();
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Agenda aziendale</h1>
      <p className="mt-2">Ciao {user.fullName}. Applicazione in costruzione.</p>
    </main>
  );
}
