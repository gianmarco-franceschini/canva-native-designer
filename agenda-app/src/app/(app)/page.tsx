import type { Metadata } from "next";
import { Chat } from "@/components/chat/chat";
import { requireUser } from "@/lib/auth/session";
import { TIME_ZONE } from "@/lib/scheduling/types";

export const metadata: Metadata = { title: "Assistente · Agenda aziendale" };

const todayFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

export default async function AssistantPage() {
  const user = await requireUser();
  return <Chat userEmail={user.email} todayLabel={`Oggi · ${todayFmt.format(new Date())}`} />;
}
