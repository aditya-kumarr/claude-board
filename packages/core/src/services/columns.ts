import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toColumn, type ColumnRow } from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId, slugify } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { COLUMN_KINDS, type BoardColumn, type ColumnKind } from "../types.ts";
import { record } from "./activity.ts";
import { getBoard, inferColumnKind } from "./boards.ts";
import type { ActorContext } from "./context.ts";
import { normalizeColumn } from "./positions.ts";

const log = createLogger("columns");

export function listColumns(boardId: string): BoardColumn[] {
  getBoard(boardId);
  return getDb()
    .query<ColumnRow, [string]>("SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC")
    .all(boardId)
    .map(toColumn);
}

export function getColumn(columnId: string): BoardColumn {
  const row = getDb().query<ColumnRow, [string]>("SELECT * FROM board_columns WHERE id = ?").get(columnId);
  if (!row) throw notFound("column", columnId);
  return toColumn(row);
}

/**
 * Resolves a column by id, or by key/name within a board — the MCP server takes
 * human-friendly identifiers like "blocked" rather than requiring `col_` ids.
 */
export function resolveColumn(boardId: string, reference: string): BoardColumn {
  const db = getDb();
  const direct = db
    .query<ColumnRow, [string, string]>("SELECT * FROM board_columns WHERE board_id = ? AND id = ?")
    .get(boardId, reference);
  if (direct) return toColumn(direct);

  const byKey = db
    .query<ColumnRow, [string, string, string]>(
      "SELECT * FROM board_columns WHERE board_id = ? AND (key = ? OR lower(name) = ?)",
    )
    .get(boardId, slugify(reference), reference.trim().toLowerCase());
  if (byKey) return toColumn(byKey);

  const available = listColumns(boardId).map((c) => c.key);
  throw notFound(`column '${reference}' on board ${boardId} (available: ${available.join(", ")})`);
}

export interface AddColumnInput {
  name: string;
  kind?: ColumnKind | string;
  /** Zero-based insertion index; appended when omitted. */
  position?: number;
  wipLimit?: number | null;
}

export function addColumn(boardId: string, input: AddColumnInput, actor: ActorContext): BoardColumn {
  getBoard(boardId);
  const name = input.name?.trim();
  if (!name) throw badRequest("column name is required");
  if (name.length > 60) throw badRequest("column name must be 60 characters or fewer");

  const kind: ColumnKind =
    input.kind && (COLUMN_KINDS as readonly string[]).includes(input.kind)
      ? (input.kind as ColumnKind)
      : inferColumnKind(name);

  const existing = listColumns(boardId);
  if (existing.length >= 12) throw conflict("a board supports at most 12 columns");
  const key = slugify(name);
  if (existing.some((column) => column.key === key)) {
    throw conflict(`this board already has a column named "${name}"`, { key });
  }

  const index = input.position ?? existing.length;
  const before = index <= 0 ? null : existing[Math.min(index, existing.length) - 1]?.position ?? null;
  const after = index >= existing.length ? null : existing[index]?.position ?? null;
  const position = before === null && after === null ? 1024 : before === null ? (after as number) - 512 : after === null ? before + 1024 : (before + after) / 2;

  const id = newId("col");
  write((db) => {
    db.run(
      `INSERT INTO board_columns (id, board_id, key, name, kind, position, wip_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, boardId, key, name, kind, position, input.wipLimit ?? null, new Date().toISOString()],
    );
    record(db, actor, "column.added", { boardId }, { columnId: id, name, key, kind });
  });

  log.info("column added", { boardId, columnId: id, name, kind, actor: actor.actorId, source: actor.source });
  return getColumn(id);
}

export interface UpdateColumnInput {
  name?: string;
  kind?: ColumnKind | string;
  position?: number;
  wipLimit?: number | null;
}

export function updateColumn(columnId: string, input: UpdateColumnInput, actor: ActorContext): BoardColumn {
  const column = getColumn(columnId);
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const changed: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest("column name cannot be empty");
    const key = slugify(name);
    const clash = listColumns(column.boardId).find((c) => c.key === key && c.id !== columnId);
    if (clash) throw conflict(`this board already has a column named "${name}"`, { key });
    sets.push("name = ?", "key = ?");
    params.push(name, key);
    changed.name = name;
  }
  if (input.kind !== undefined) {
    if (!(COLUMN_KINDS as readonly string[]).includes(input.kind)) {
      throw badRequest(`kind must be one of ${COLUMN_KINDS.join(", ")}`, { received: input.kind });
    }
    sets.push("kind = ?");
    params.push(input.kind);
    changed.kind = input.kind;
  }
  if (input.wipLimit !== undefined) {
    if (input.wipLimit !== null && (!Number.isInteger(input.wipLimit) || input.wipLimit < 1)) {
      throw badRequest("wipLimit must be a positive integer or null");
    }
    sets.push("wip_limit = ?");
    params.push(input.wipLimit);
    changed.wipLimit = input.wipLimit;
  }
  if (input.position !== undefined) {
    const others = listColumns(column.boardId).filter((c) => c.id !== columnId);
    const index = Math.max(0, Math.min(input.position, others.length));
    const before = index === 0 ? null : others[index - 1]?.position ?? null;
    const after = index >= others.length ? null : others[index]?.position ?? null;
    const next =
      before === null && after === null ? 1024 : before === null ? (after as number) - 512 : after === null ? before + 1024 : (before + after) / 2;
    sets.push("position = ?");
    params.push(next);
    changed.position = index;
  }

  if (sets.length === 0) return column;

  write((db) => {
    db.run(`UPDATE board_columns SET ${sets.join(", ")} WHERE id = ?`, [...params, columnId]);
    record(db, actor, "column.updated", { boardId: column.boardId }, { columnId, ...changed });
  });

  log.info("column updated", { columnId, boardId: column.boardId, changed, actor: actor.actorId });
  return getColumn(columnId);
}

/**
 * Deletes a column. Its tasks move to `moveTasksTo` (or the leftmost remaining
 * column) rather than being destroyed — losing work to a layout change would be
 * a nasty surprise.
 */
export function deleteColumn(
  columnId: string,
  options: { moveTasksTo?: string } = {},
  actor: ActorContext,
): { movedTasks: number; movedTo: string | null } {
  const column = getColumn(columnId);
  const siblings = listColumns(column.boardId).filter((c) => c.id !== columnId);
  if (siblings.length === 0) throw conflict("a board must keep at least one column");

  const target = options.moveTasksTo ? resolveColumn(column.boardId, options.moveTasksTo) : siblings[0]!;
  if (target.id === columnId) throw badRequest("moveTasksTo cannot be the column being deleted");

  const taskIds = getDb()
    .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE column_id = ?")
    .all(columnId)
    .map((row) => row.id);

  write((db) => {
    if (taskIds.length > 0) {
      db.run("UPDATE tasks SET column_id = ?, updated_at = ? WHERE column_id = ?", [
        target.id,
        new Date().toISOString(),
        columnId,
      ]);
      // Tasks arrive carrying their old positions; re-space so ordering is sane.
      normalizeColumn(db, target.id);
    }
    db.run("DELETE FROM board_columns WHERE id = ?", [columnId]);
    record(db, actor, "column.deleted", { boardId: column.boardId }, {
      columnId,
      name: column.name,
      movedTasks: taskIds.length,
      movedTo: target.id,
    });
  });

  log.warn("column deleted", {
    columnId,
    boardId: column.boardId,
    name: column.name,
    movedTasks: taskIds.length,
    movedTo: target.key,
    actor: actor.actorId,
  });
  return { movedTasks: taskIds.length, movedTo: target.id };
}
