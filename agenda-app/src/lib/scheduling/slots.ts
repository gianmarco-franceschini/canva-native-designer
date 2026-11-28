import { TZDate } from "@date-fns/tz";
import { findConflicts } from "./conflicts";
import { isItalianHoliday } from "./holidays";
import { TIME_ZONE, type BusyByPerson, type Interval, type WorkHours } from "./types";

export type FindFreeSlotsInput = {
  busy: BusyByPerson;
  from: Date;
  to: Date;
  durationMinutes: number;
  workHours: WorkHours;
  /** Chiusure aziendali, "YYYY-MM-DD" (calendario di Roma). */
  closures: string[];
  now: Date;
  limit?: number;
  stepMinutes?: number;
};

const MINUTE_MS = 60_000;

function parseTime(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(":").map(Number);
  return { hours: h, minutes: m };
}

function dayKey(d: TZDate): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Primi `limit` slot liberi per tutti, in ordine cronologico. I candidati sono
 * allineati a `stepMinutes` dall'inizio di ogni fascia; dopo uno slot accettato
 * si riparte dalla sua fine, così gli slot restituiti non si sovrappongono.
 */
export function findFreeSlots(input: FindFreeSlotsInput): Interval[] {
  const { busy, from, to, durationMinutes, workHours, closures, now } = input;
  const limit = input.limit ?? 3;
  const stepMs = (input.stepMinutes ?? 30) * MINUTE_MS;
  const durationMs = durationMinutes * MINUTE_MS;
  const closed = new Set(closures);
  const slots: Interval[] = [];

  const first = new TZDate(from.getTime(), TIME_ZONE);
  const day = new TZDate(first.getFullYear(), first.getMonth(), first.getDate(), TIME_ZONE);

  for (; day.getTime() <= to.getTime() && slots.length < limit; day.setDate(day.getDate() + 1)) {
    const isoWeekday = day.getDay() === 0 ? 7 : day.getDay();
    if (!workHours.days.includes(isoWeekday)) continue;
    if (closed.has(dayKey(day)) || isItalianHoliday(new Date(day.getTime()))) continue;

    for (const range of workHours.ranges) {
      const open = parseTime(range.from);
      const close = parseTime(range.to);
      const rangeStart = new TZDate(day.getFullYear(), day.getMonth(), day.getDate(), open.hours, open.minutes, TIME_ZONE).getTime();
      const rangeEnd = new TZDate(day.getFullYear(), day.getMonth(), day.getDate(), close.hours, close.minutes, TIME_ZONE).getTime();

      let nextAllowed = rangeStart;
      for (let t = rangeStart; t + durationMs <= rangeEnd; t += stepMs) {
        if (slots.length >= limit) return slots;
        if (t < nextAllowed) continue;
        const slot = { start: new Date(t), end: new Date(t + durationMs) };
        if (slot.start < from || slot.end > to || slot.start < now) continue;
        if (findConflicts(busy, slot).length > 0) continue;
        slots.push(slot);
        nextAllowed = t + durationMs;
      }
    }
  }
  return slots;
}
