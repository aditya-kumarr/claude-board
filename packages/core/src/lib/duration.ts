import { DURATION_KINDS, type DurationKind, type BoardWindow } from "../types.ts";
import { badRequest } from "./errors.ts";

const DAY_MS = 86_400_000;

export function isDurationKind(value: unknown): value is DurationKind {
  return typeof value === "string" && (DURATION_KINDS as readonly string[]).includes(value);
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/** Monday of the ISO week containing `d`, at local midnight. */
function startOfIsoWeek(d: Date): Date {
  const start = startOfDay(d);
  const shift = (start.getDay() + 6) % 7; // Monday -> 0 ... Sunday -> 6
  start.setDate(start.getDate() - shift);
  return start;
}

export function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} must be an ISO date string`);
  }
  // A bare `YYYY-MM-DD` is treated as the end of that local day, which is what
  // a person means by "due on the 24th" — not 00:00 on the 24th.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const parsed = new Date(dateOnly ? `${value.trim()}T23:59:59.999` : value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} is not a valid date: ${value}`);
  return parsed;
}

export interface WindowInput {
  durationKind: DurationKind;
  /** Defaults to now. For non-custom kinds this only picks *which* day/week/month. */
  anchor?: Date | string;
  /** Required when durationKind is "custom". */
  endsAt?: Date | string;
  /** Optional explicit start; otherwise derived from the kind. */
  startsAt?: Date | string;
}

/**
 * Turns a duration kind into a concrete [startsAt, endsAt] window. This is the
 * single source of truth for a board's deadline — every task due date is
 * validated against the `endsAt` it produces.
 */
export function resolveWindow(input: WindowInput): { startsAt: Date; endsAt: Date } {
  const anchor = input.anchor ? parseDate(input.anchor, "anchor") : new Date();

  let startsAt: Date;
  let endsAt: Date;

  switch (input.durationKind) {
    case "day":
      startsAt = startOfDay(anchor);
      endsAt = endOfDay(anchor);
      break;
    case "week": {
      startsAt = startOfIsoWeek(anchor);
      const sunday = new Date(startsAt);
      sunday.setDate(sunday.getDate() + 6);
      endsAt = endOfDay(sunday);
      break;
    }
    case "month":
      startsAt = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      endsAt = endOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
      break;
    case "quarter": {
      const firstMonth = Math.floor(anchor.getMonth() / 3) * 3;
      startsAt = new Date(anchor.getFullYear(), firstMonth, 1);
      endsAt = endOfDay(new Date(anchor.getFullYear(), firstMonth + 3, 0));
      break;
    }
    case "year":
      startsAt = new Date(anchor.getFullYear(), 0, 1);
      endsAt = endOfDay(new Date(anchor.getFullYear(), 11, 31));
      break;
    case "custom": {
      if (!input.endsAt) throw badRequest("a custom duration requires endsAt");
      startsAt = input.startsAt ? parseDate(input.startsAt, "startsAt") : startOfDay(anchor);
      endsAt = parseDate(input.endsAt, "endsAt");
      break;
    }
  }

  if (input.startsAt && input.durationKind !== "custom") startsAt = parseDate(input.startsAt, "startsAt");
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw badRequest("board window ends before it starts", {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
  }
  return { startsAt, endsAt };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function describeWindow(kind: DurationKind, startsAt: Date, endsAt: Date): string {
  const sameYear = startsAt.getFullYear() === endsAt.getFullYear();
  const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  switch (kind) {
    case "day":
      return `${day(startsAt)} ${startsAt.getFullYear()}`;
    case "week":
      return `Week of ${startsAt.getDate()}–${endsAt.getDate()} ${MONTHS[endsAt.getMonth()]} ${endsAt.getFullYear()}`;
    case "month":
      return `${MONTHS[startsAt.getMonth()]} ${startsAt.getFullYear()}`;
    case "quarter":
      return `Q${Math.floor(startsAt.getMonth() / 3) + 1} ${startsAt.getFullYear()}`;
    case "year":
      return String(startsAt.getFullYear());
    case "custom":
      return sameYear
        ? `${day(startsAt)} – ${day(endsAt)} ${endsAt.getFullYear()}`
        : `${day(startsAt)} ${startsAt.getFullYear()} – ${day(endsAt)} ${endsAt.getFullYear()}`;
  }
}

export function buildWindow(kind: DurationKind, startsAtIso: string, endsAtIso: string, now = new Date()): BoardWindow {
  const startsAt = new Date(startsAtIso);
  const endsAt = new Date(endsAtIso);
  const totalMs = Math.max(1, endsAt.getTime() - startsAt.getTime());
  const elapsedMs = Math.min(Math.max(0, now.getTime() - startsAt.getTime()), totalMs);
  const remainingMs = Math.max(0, endsAt.getTime() - now.getTime());
  return {
    startsAt: startsAtIso,
    endsAt: endsAtIso,
    label: describeWindow(kind, startsAt, endsAt),
    totalMs,
    elapsedMs,
    remainingMs,
    progress: elapsedMs / totalMs,
    expired: now.getTime() > endsAt.getTime(),
  };
}

/** "3d 4h left" / "overdue by 2h" — used in log lines and MCP responses. */
export function humanizeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
