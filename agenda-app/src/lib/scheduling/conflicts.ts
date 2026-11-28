import type { BusyByPerson, Interval } from "./types";

export type Conflict = { email: string; start: Date; end: Date };

/** Sovrapposizione stretta: intervalli adiacenti non sono in conflitto. */
export function findConflicts(busy: BusyByPerson, slot: Interval): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const [email, intervals] of Object.entries(busy)) {
    for (const b of intervals) {
      if (slot.start < b.end && b.start < slot.end) {
        conflicts.push({ email, start: b.start, end: b.end });
      }
    }
  }
  return conflicts.sort(
    (x, y) => x.start.getTime() - y.start.getTime() || x.email.localeCompare(y.email),
  );
}
