import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * packages/core/src/lib -> repo root is four levels up. Resolving from the
 * module location (rather than cwd) keeps the server, the MCP server and any
 * one-off script pointed at the same database and log directory no matter
 * which directory they were launched from.
 */
export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");

function fromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return resolve(REPO_ROOT, fallback);
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export const DB_PATH = fromEnv("AUTOMATION_DB_PATH", "data/board.db");
export const LOG_DIR = fromEnv("AUTOMATION_LOG_DIR", "logs");

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
