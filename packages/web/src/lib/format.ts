import type { BoardWindow, Priority } from "./types";

const DAY_MS = 86_400_000;

/** "2d 4h left" / "3h 12m overdue" — the phrasing used across the header and cards. */
export function humanizeMs(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / DAY_MS);
  const hours = Math.floor((abs % DAY_MS) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

export function remainingLabel(window: BoardWindow, now = Date.now()): string {
  const remaining = new Date(window.endsAt).getTime() - now;
  return remaining <= 0 ? `${humanizeMs(remaining)} over` : `${humanizeMs(remaining)} left`;
}

/** Colour ramp for the deadline bar: calm early, amber near the end, red once past. */
export function urgencyColor(window: BoardWindow, now = Date.now()): string {
  const total = Math.max(1, new Date(window.endsAt).getTime() - new Date(window.startsAt).getTime());
  const elapsed = now - new Date(window.startsAt).getTime();
  const ratio = elapsed / total;
  if (ratio >= 1) return "var(--kind-blocked)";
  if (ratio >= 0.85) return "var(--prio-urgent)";
  if (ratio >= 0.6) return "var(--kind-review)";
  return "var(--kind-active)";
}

export function progressPercent(window: BoardWindow, now = Date.now()): number {
  const total = Math.max(1, new Date(window.endsAt).getTime() - new Date(window.startsAt).getTime());
  const elapsed = now - new Date(window.startsAt).getTime();
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDue(iso: string | null, now = Date.now()): string {
  if (!iso) return "no date";
  const date = new Date(iso);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.round((date.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return "today";
  if (dayDelta === 1) return "tomorrow";
  if (dayDelta === -1) return "yesterday";
  if (dayDelta > 1 && dayDelta < 7) return WEEKDAYS[date.getDay()]!;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const delta = now - new Date(iso).getTime();
  if (delta < 60_000) return "just now";
  return `${humanizeMs(delta)} ago`;
}

/** `<input type="datetime-local">` needs local wall-clock text, not an ISO instant. */
export function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
