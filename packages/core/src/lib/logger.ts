import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, LOG_DIR } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const ANSI: Record<LogLevel, string> = {
  debug: "\x1b[38;5;244m",
  info: "\x1b[38;5;39m",
  warn: "\x1b[38;5;214m",
  error: "\x1b[38;5;203m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function parseLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  const candidate = raw?.trim().toLowerCase();
  return candidate && candidate in LEVEL_ORDER ? (candidate as LogLevel) : fallback;
}

const MIN_LEVEL = parseLevel(process.env.LOG_LEVEL, "info");

/**
 * ISO-8601 week key, e.g. `2026-W34`. Weeks start Monday, and a week belongs to
 * the year containing its Thursday, so the file for the last days of December
 * can legitimately be named after the following January.
 */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7; // Sunday (0) counts as day 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // shift onto this week's Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function localTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * One append-mode file descriptor, reopened when the ISO week rolls over so a
 * long-running process does not keep writing into last week's file.
 */
class WeeklyLogFile {
  private fd: number | null = null;
  private weekKey = "";

  private handleFor(date: Date): number | null {
    const key = isoWeekKey(date);
    if (this.fd !== null && key === this.weekKey) return this.fd;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* the descriptor is being replaced regardless */
      }
      this.fd = null;
    }
    try {
      ensureDir(LOG_DIR);
      this.fd = openSync(join(LOG_DIR, `${key}.log`), "a");
      this.weekKey = key;
    } catch (error) {
      // Never let logging take the process down; fall back to stderr only.
      process.stderr.write(`[logger] cannot open log file: ${String(error)}\n`);
      this.fd = null;
      this.weekKey = "";
    }
    return this.fd;
  }

  write(date: Date, line: string): void {
    const fd = this.handleFor(date);
    if (fd === null) return;
    try {
      writeSync(fd, line);
    } catch (error) {
      process.stderr.write(`[logger] write failed: ${String(error)}\n`);
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } finally {
      this.fd = null;
      this.weekKey = "";
    }
  }

  currentPath(date = new Date()): string {
    return join(LOG_DIR, `${isoWeekKey(date)}.log`);
  }
}

const file = new WeeklyLogFile();
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => file.close());
}

export type LogContext = Record<string, unknown>;

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function stringifyContext(context: LogContext): string {
  const entries = Object.entries(context).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) normalized[key] = serializeError(value);
  try {
    return JSON.stringify(normalized);
  } catch {
    return JSON.stringify({ contextSerializationFailed: true });
  }
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger that merges `bound` into every entry it writes. */
  child(bound: LogContext): Logger;
  readonly scope: string;
}

/**
 * Console output always goes to stderr: the MCP server owns stdout for the
 * JSON-RPC stream, and a stray log line there corrupts the protocol.
 */
function emit(scope: string, bound: LogContext, level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const now = new Date();
  const timestamp = localTimestamp(now);
  const merged: LogContext = { ...bound, ...context };
  const suffix = stringifyContext(merged);
  const label = level.toUpperCase().padEnd(5);

  file.write(now, `${timestamp} ${label} [${scope}] ${message}${suffix ? ` ${suffix}` : ""}\n`);

  const color = process.stderr.isTTY ? ANSI[level] : "";
  const reset = process.stderr.isTTY ? RESET : "";
  const dim = process.stderr.isTTY ? DIM : "";
  process.stderr.write(
    `${dim}${timestamp.slice(11, 23)}${reset} ${color}${label}${reset} ${dim}[${scope}]${reset} ${message}` +
      `${suffix ? ` ${dim}${suffix}${reset}` : ""}\n`,
  );
}

export function createLogger(scope: string, bound: LogContext = {}): Logger {
  return {
    scope,
    debug: (message, context) => emit(scope, bound, "debug", message, context),
    info: (message, context) => emit(scope, bound, "info", message, context),
    warn: (message, context) => emit(scope, bound, "warn", message, context),
    error: (message, context) => emit(scope, bound, "error", message, context),
    child: (extra) => createLogger(scope, { ...bound, ...extra }),
  };
}

export const currentLogFile = (): string => file.currentPath();
export const logLevel = MIN_LEVEL;
