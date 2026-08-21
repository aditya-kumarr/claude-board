/**
 * Ordered, append-only migrations. Each entry runs once inside a transaction
 * and is recorded in `schema_migrations`; never edit a shipped statement, add a
 * new one instead.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: /* sql */ `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('human','agent')),
        created_at    TEXT NOT NULL
      );

      CREATE TABLE boards (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        duration_kind TEXT NOT NULL CHECK (duration_kind IN ('day','week','month','quarter','year','custom')),
        starts_at     TEXT NOT NULL,
        ends_at       TEXT NOT NULL,
        archived      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE board_columns (
        id         TEXT PRIMARY KEY,
        board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('backlog','active','blocked','review','done')),
        position   REAL NOT NULL,
        wip_limit  INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (board_id, key)
      );

      CREATE TABLE tasks (
        id             TEXT PRIMARY KEY,
        board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        column_id      TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        description    TEXT,
        assignee_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_by     TEXT NOT NULL REFERENCES users(id),
        priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
        due_at         TEXT,
        position       REAL NOT NULL,
        completed_at   TEXT,
        blocked_reason TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_board    ON tasks (board_id, column_id, position);
      CREATE INDEX idx_tasks_assignee ON tasks (assignee_id, completed_at);
      CREATE INDEX idx_tasks_due      ON tasks (due_at);

      CREATE TABLE task_comments (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id  TEXT NOT NULL REFERENCES users(id),
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_comments_task ON task_comments (task_id, created_at);

      CREATE TABLE activity (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id   TEXT,
        task_id    TEXT,
        actor_id   TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        source     TEXT NOT NULL CHECK (source IN ('web','mcp','system')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_activity_board ON activity (board_id, id DESC);
      CREATE INDEX idx_activity_task  ON activity (task_id, id DESC);

      -- Single-row counter bumped by every write. The web client polls it so it
      -- can pick up changes the agent made directly through the MCP server.
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO meta (key, value) VALUES ('revision', '0');
    `,
  },
];

/** Assignees exist before any board does, so both transports can reference them. */
export const SEED_USERS = [
  { id: "me", displayName: "Me", kind: "human" as const },
  { id: "claude", displayName: "Claude", kind: "agent" as const },
];

/** Applied to every new board; users can add, rename or delete columns after. */
export const DEFAULT_COLUMNS = [
  { key: "todo", name: "To do", kind: "backlog" as const },
  { key: "doing", name: "Doing", kind: "active" as const },
  { key: "blocked", name: "Blocked", kind: "blocked" as const },
  { key: "needs_review", name: "Needs review", kind: "review" as const },
  { key: "done", name: "Done", kind: "done" as const },
];
