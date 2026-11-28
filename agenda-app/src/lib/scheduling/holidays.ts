import { TZDate } from "@date-fns/tz";
import { TIME_ZONE } from "./types";

/** Festività fisse come "MM-DD" (calendario di Roma). */
const FIXED_HOLIDAYS = new Set([
  "01-01", // Capodanno
  "01-06", // Epifania
  "04-25", // Festa della Liberazione
  "05-01", // Festa del Lavoro
  "06-02", // Festa della Repubblica
  "08-15", // Ferragosto
  "11-01", // Ognissanti
  "12-08", // Immacolata
  "12-25", // Natale
  "12-26", // Santo Stefano
]);

/** Pasqua gregoriana (algoritmo anonimo di Gauss/Meeus). Restituisce mese 1-12 e giorno. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** True se `day`, valutato in Europe/Rome, è una festività nazionale italiana. */
export function isItalianHoliday(day: Date): boolean {
  const rome = new TZDate(day.getTime(), TIME_ZONE);
  const year = rome.getFullYear();
  const month = rome.getMonth() + 1;
  const date = rome.getDate();
  const key = `${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  if (FIXED_HOLIDAYS.has(key)) return true;

  const easter = easterSunday(year);
  // Pasquetta = Pasqua + 1 giorno (Date.UTC gestisce il passaggio di mese).
  const monday = new Date(Date.UTC(year, easter.month - 1, easter.day + 1));
  return month === monday.getUTCMonth() + 1 && date === monday.getUTCDate();
}
