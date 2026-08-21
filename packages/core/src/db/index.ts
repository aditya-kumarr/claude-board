import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { DB_PATH, ensureDir } from "../lib/paths.ts";
import { createLogger } from "../lib/logger.ts";
import { MIGRATIONS, SEED_USERS } from "./schema.ts";

const log = createLogger("db");

let instance: Database | null = null;

function applyMigrations(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const started = performance.now();
    // bun:sqlite runs a transaction per callback; a failed migration rolls back
    // whole so the database is never left half-upgraded.
    db.transaction(() => {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    })();
    log.info("migration applied", {
      version: migration.version,
      name: migration.name,
      ms: Math.round(performance.now() - started),
    });
  }
}

function seedUsers(db: Database): void {
  const insert = db.prepare(
    "INSERT INTO users (id, display_name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const user of SEED_USERS) insert.run(user.id, user.displayName, user.kind, now);
  })();
}

/**
 * Process-wide connection. WAL plus a busy timeout is what lets the Express API
 * and the MCP server hold the same file open at once without `SQLITE_BUSY`.
 */
export function getDb(): Database {
  if (instance) return instance;
  ensureDir(dirname(DB_PATH));
  const db = new Database(DB_PATH, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  applyMigrations(db);
  seedUsers(db);
  instance = db;
  log.info("database ready", { path: DB_PATH });
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** Runs `fn` in a transaction and bumps the revision counter exactly once. */
export function write<T>(fn: (db: Database) => T): T {
  const db = getDb();
  return db.transaction(() => {
    const result = fn(db);
    db.run("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'");
    return result;
  })();
}

export function getRevision(): number {
  const row = getDb().query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'revision'").get();
  return row ? Number(row.value) : 0;
}

export { Database };
