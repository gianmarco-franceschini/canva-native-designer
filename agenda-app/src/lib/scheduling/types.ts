export type Interval = { start: Date; end: Date };

/** Intervalli occupati per persona, indicizzati per email. */
export type BusyByPerson = Record<string, Interval[]>;

/** `days`: 1 = lunedì ... 7 = domenica. Gli orari sono ora di Roma ("HH:mm"). */
export type WorkHours = {
  days: number[];
  ranges: { from: string; to: string }[];
};

export const DEFAULT_WORK_HOURS: WorkHours = {
  days: [1, 2, 3, 4, 5],
  ranges: [
    { from: "09:00", to: "13:00" },
    { from: "14:00", to: "18:00" },
  ],
};

export const TIME_ZONE = "Europe/Rome";
