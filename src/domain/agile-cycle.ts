import { z } from "zod";
import { SkillSettingsSchema } from "./skill-allowlist";

const dayMilliseconds = 86_400_000;

/** Parses an ISO calendar date into numeric parts. */
function dateParts(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = value
    .split("-")
    .map(Number);
  return { year, month, day };
}

const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const { year, month, day } = dateParts(value);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

export const AgileCycleSettingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily") }).strict(),
  z.object({ type: z.literal("weekly") }).strict(),
  z
    .object({
      type: z.literal("custom"),
      days: z.number().int().positive(),
      anchorDate: LocalDateSchema,
    })
    .strict(),
]);

export const RocSettingsSchema = z
  .object({
    cycle: AgileCycleSettingSchema,
    skills: SkillSettingsSchema.optional(),
  })
  .strict();

export type AgileCycleSetting = z.infer<typeof AgileCycleSettingSchema>;
export type RocSettings = z.infer<typeof RocSettingsSchema>;
export type ActiveAgileCycle = {
  id: string;
  startDate: string;
  endDate: string;
};

/** Formats a Date as a local ISO calendar date. */
function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Converts an ISO calendar date to an integer UTC day number. */
function dayNumber(value: string): number {
  const { year, month, day } = dateParts(value);
  return Math.floor(Date.UTC(year, month - 1, day) / dayMilliseconds);
}

/** Formats an integer UTC day number as an ISO calendar date. */
function dateForDayNumber(value: number): string {
  return new Date(value * dayMilliseconds).toISOString().slice(0, 10);
}

/** Returns the ISO week identifier containing an ISO calendar date. */
function isoWeekId(value: string): string {
  const target = new Date(dayNumber(value) * dayMilliseconds);
  const mondayBasedDay = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - mondayBasedDay + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Calculates the active cycle for validated settings and a local clock. */
export function activeAgileCycle(
  input: AgileCycleSetting,
  now = new Date(),
): ActiveAgileCycle {
  const setting = AgileCycleSettingSchema.parse(input);
  const today = localDate(now);
  const todayNumber = dayNumber(today);
  if (setting.type === "daily") {
    return { id: today, startDate: today, endDate: today };
  }
  if (setting.type === "weekly") {
    const current = new Date(todayNumber * dayMilliseconds);
    const startNumber = todayNumber - ((current.getUTCDay() + 6) % 7);
    return {
      id: isoWeekId(today),
      startDate: dateForDayNumber(startNumber),
      endDate: dateForDayNumber(startNumber + 6),
    };
  }
  const anchorNumber = dayNumber(setting.anchorDate);
  if (todayNumber < anchorNumber) {
    throw new Error("Current date is before the custom cycle anchor");
  }
  const startNumber =
    anchorNumber +
    Math.floor((todayNumber - anchorNumber) / setting.days) * setting.days;
  const startDate = dateForDayNumber(startNumber);
  return {
    id: `${startDate}-P${setting.days}D`,
    startDate,
    endDate: dateForDayNumber(startNumber + setting.days - 1),
  };
}
