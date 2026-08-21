import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { toActivity, type ActivityRow } from "../db/rows.ts";
import type { ActivityEntry } from "../types.ts";
import type { ActorContext } from "./context.ts";

/**
 * Appends an audit row. Called inside the caller's transaction so an activity
 * entry can never outlive the change it describes.
 */
export function record(
  db: Database,
  actor: ActorContext,
  action: string,
  target: { boardId?: string | null; taskId?: string | null },
  detail?: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO activity (board_id, task_id, actor_id, action, detail, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      target.boardId ?? null,
      target.taskId ?? null,
      actor.actorId,
      action,
      detail ? JSON.stringify(detail) : null,
      actor.source,
      new Date().toISOString(),
    ],
  );
}

export function listActivity(options: { boardId?: string; taskId?: string; limit?: number } = {}): ActivityEntry[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.boardId) {
    where.push("board_id = ?");
    params.push(options.boardId);
  }
  if (options.taskId) {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return getDb()
    .query<ActivityRow, SQLQueryBindings[]>(sql)
    .all(...params, limit)
    .map(toActivity);
}
