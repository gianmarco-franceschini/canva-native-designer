import { TIME_ZONE } from "@/lib/scheduling/types";

const dayFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE });

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatDay = (iso: string) => capitalize(dayFmt.format(new Date(iso)));
export const sameRomeDay = (a: string, b: string) =>
  dayKeyFmt.format(new Date(a)) === dayKeyFmt.format(new Date(b));

/** "Gio 27 nov · 10:00–11:00" (con la data di fine se diversa). */
export function formatRange(start: string, end: string): string {
  if (sameRomeDay(start, end)) return `${formatDay(start)} · ${formatTime(start)}–${formatTime(end)}`;
  return `${formatDay(start)} ${formatTime(start)} – ${formatDay(end)} ${formatTime(end)}`;
}
