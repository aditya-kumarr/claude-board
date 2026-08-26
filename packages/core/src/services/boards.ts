import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toBoard, toColumn, toTask, type BoardRow, type ColumnRow, type TaskRow } from "../db/rows.ts";
import { buildWindow, isDurationKind, parseDate, resolveWindow } from "../lib/duration.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { createLogger } from "../lib/logger.ts";
import { newId, slugify } from "../lib/ids.ts";
import { DEFAULT_COLUMNS } from "../db/schema.ts";
import type { Board, BoardDetail, BoardStats, DurationKind } from "../types.ts";
import { USER_CLAUDE, USER_ME } from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";
import { listMentions } from "./mentions.ts";
import { getSyncSummary } from "./sync.ts";

const log = createLogger("boards");

export interface CreateBoardInput {
  name: string;
  description?: string | null;
  durationKind: DurationKind | string;
  /** Which day/week/month the board covers; defaults to today. */
  anchor?: string;
  startsAt?: string;
  /** Required for `custom`. */
  endsAt?: string;
  /** Column names to use instead of the defaults, left to right. */
  columns?: string[];
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("name is required");
  if (value.trim().length > 200) throw badRequest("name must be 200 characters or fewer");
  return value.trim();
}

/**
 * Guesses a semantic kind from a user-supplied column name so custom columns
 * still participate in stats (a column called "In review" counts as review).
 */
export function inferColumnKind(name: string): "backlog" | "active" | "blocked" | "review" | "done" {
  const n = name.toLowerCase();
  if (/(^|\b)(done|complete|completed|shipped|closed|finished)\b/.test(n)) return "done";
  if (/(review|qa|verify|approval|sign.?off)/.test(n)) return "review";
  if (/(block|stuck|waiting|on.?hold|paused)/.test(n)) return "blocked";
  if (/(doing|progress|active|current|wip|building)/.test(n)) return "active";
  return "backlog";
}

export function createBoard(input: CreateBoardInput, actor: ActorContext): BoardDetail {
  const name = requireName(input.name);
  if (!isDurationKind(input.durationKind)) {
    throw badRequest(`durationKind must be one of day, week, month, quarter, year, custom`, {
      received: input.durationKind,
    });
  }
  const { startsAt, endsAt } = resolveWindow({
    durationKind: input.durationKind,
    anchor: input.anchor,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  });

  const columnNames = input.columns?.length ? input.columns : null;
  if (columnNames && columnNames.length > 12) throw badRequest("a board supports at most 12 columns");

  const id = newId("brd");
  const now = new Date().toISOString();

  write((db) => {
    db.run(
      `INSERT INTO boards (id, name, description, duration_kind, starts_at, ends_at, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, name, input.description?.trim() || null, input.durationKind, startsAt.toISOString(), endsAt.toISOString(), now, now],
    );

    const columns = columnNames
      ? columnNames.map((columnName, index) => ({
          key: slugify(columnName) || `col_${index + 1}`,
          name: columnName.trim(),
          kind: inferColumnKind(columnName),
        }))
      : DEFAULT_COLUMNS;

    const insertColumn = db.prepare(
      `INSERT INTO board_columns (id, board_id, key, name, kind, position, wip_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    columns.forEach((column, index) => {
      insertColumn.run(newId("col"), id, column.key, column.name, column.kind, (index + 1) * 1024, now);
    });

    record(db, actor, "board.created", { boardId: id }, {
      name,
      durationKind: input.durationKind,
      endsAt: endsAt.toISOString(),
      columns: columns.length,
    });
  });

  log.info("board created", {
    boardId: id,
    name,
    durationKind: input.durationKind,
    endsAt: endsAt.toISOString(),
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });

  return getBoardDetail(id);
}

export function getBoard(boardId: string): Board {
  const row = getDb().query<BoardRow, [string]>("SELECT * FROM boards WHERE id = ?").get(boardId);
  if (!row) throw notFound("board", boardId);
  return toBoard(row);
}

export interface ListBoardsOptions {
  includeArchived?: boolean;
}

export function listBoards(options: ListBoardsOptions = {}): BoardDetail[] {
  const rows = getDb()
    .query<BoardRow, []>(
      `SELECT * FROM boards ${options.includeArchived ? "" : "WHERE archived = 0"} ORDER BY datetime(ends_at) ASC, created_at DESC`,
    )
    .all();
  return rows.map((row) => getBoardDetail(row.id));
}

export function computeStats(boardId: string): BoardStats {
  const db = getDb();
  const openMentions =
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM task_mentions WHERE board_id = ? AND status IN ('pending','claimed')",
      )
      .get(boardId)?.count ?? 0;
  const rows = db
    .query<{ kind: string; assignee_id: string | null; due_at: string | null; completed_at: string | null }, [string]>(
      `SELECT c.kind AS kind, t.assignee_id, t.due_at, t.completed_at
         FROM tasks t JOIN board_columns c ON c.id = t.column_id
        WHERE t.board_id = ?`,
    )
    .all(boardId);

  const now = Date.now();
  const stats: BoardStats = {
    total: rows.length,
    done: 0,
    blocked: 0,
    review: 0,
    active: 0,
    backlog: 0,
    overdue: 0,
    assignedToMe: 0,
    assignedToClaude: 0,
    unassigned: 0,
    openMentions,
  };

  for (const row of rows) {
    switch (row.kind) {
      case "done":
        stats.done += 1;
        break;
      case "blocked":
        stats.blocked += 1;
        break;
      case "review":
        stats.review += 1;
        break;
      case "active":
        stats.active += 1;
        break;
      default:
        stats.backlog += 1;
    }
    // Only unfinished work can be overdue.
    if (row.kind !== "done" && row.due_at && new Date(row.due_at).getTime() < now) stats.overdue += 1;
    if (row.assignee_id === USER_ME) stats.assignedToMe += 1;
    else if (row.assignee_id === USER_CLAUDE) stats.assignedToClaude += 1;
    else if (row.assignee_id === null) stats.unassigned += 1;
  }
  return stats;
}

export function getBoardDetail(boardId: string): BoardDetail {
  const board = getBoard(boardId);
  const db = getDb();
  const columns = db
    .query<ColumnRow, [string]>("SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC")
    .all(boardId)
    .map(toColumn);
  const tasks = db
    .query<TaskRow, [string]>("SELECT * FROM tasks WHERE board_id = ? ORDER BY position ASC")
    .all(boardId)
    .map(toTask);
  return {
    board,
    window: buildWindow(board.durationKind, board.startsAt, board.endsAt),
    columns,
    tasks,
    stats: computeStats(boardId),
    openMentions: listMentions({ boardId, includeArchivedBoards: true, limit: 200 }),
    sync: getSyncSummary(boardId),
  };
}

export interface UpdateBoardInput {
  name?: string;
  description?: string | null;
  durationKind?: DurationKind | string;
  anchor?: string;
  startsAt?: string;
  endsAt?: string;
  archived?: boolean;
}

export function updateBoard(boardId: string, input: UpdateBoardInput, actor: ActorContext): BoardDetail {
  const existing = getBoard(boardId);
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const changed: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = requireName(input.name);
    sets.push("name = ?");
    params.push(name);
    changed.name = name;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    sets.push("description = ?");
    params.push(description);
    changed.description = description;
  }

  // Any duration change re-derives the whole window, then re-checks that no
  // existing task is now due after the board closes.
  const durationChanged =
    input.durationKind !== undefined || input.endsAt !== undefined || input.startsAt !== undefined || input.anchor !== undefined;

  let newEndsAt = existing.endsAt;
  if (durationChanged) {
    // An explicit endsAt only means something for a custom window — every other
    // kind derives its end from the calendar period. Rather than accept the
    // field and silently ignore it, treat it as a switch to custom.
    const requestedKind = input.durationKind ?? existing.durationKind;
    const kind =
      input.endsAt !== undefined && requestedKind !== "custom" && input.durationKind === undefined
        ? "custom"
        : requestedKind;
    if (!isDurationKind(kind)) throw badRequest("durationKind is not a valid duration", { received: kind });
    if (input.endsAt !== undefined && input.durationKind !== undefined && input.durationKind !== "custom") {
      throw badRequest(
        `endsAt only applies to a custom duration; a ${input.durationKind} board's end is derived from the calendar period`,
        { durationKind: input.durationKind, endsAt: input.endsAt },
      );
    }
    const window = resolveWindow({
      durationKind: kind,
      anchor: input.anchor ?? (kind === existing.durationKind ? existing.startsAt : undefined),
      startsAt: input.startsAt ?? (input.anchor || input.durationKind ? undefined : existing.startsAt),
      endsAt: input.endsAt ?? (kind === "custom" ? existing.endsAt : undefined),
    });
    newEndsAt = window.endsAt.toISOString();
    sets.push("duration_kind = ?", "starts_at = ?", "ends_at = ?");
    params.push(kind, window.startsAt.toISOString(), newEndsAt);
    changed.durationKind = kind;
    changed.startsAt = window.startsAt.toISOString();
    changed.endsAt = newEndsAt;
  }

  if (input.archived !== undefined) {
    sets.push("archived = ?");
    params.push(input.archived ? 1 : 0);
    changed.archived = input.archived;
  }

  if (sets.length === 0) return getBoardDetail(boardId);

  write((db) => {
    db.run(`UPDATE boards SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
      ...params,
      new Date().toISOString(),
      boardId,
    ]);

    if (durationChanged) {
      // Pull any task deadline back to the new board close so the invariant
      // "every task ends within the board's duration" always holds.
      const clamped = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM tasks WHERE board_id = ? AND due_at IS NOT NULL AND datetime(due_at) > datetime(?)",
        )
        .all(boardId, newEndsAt);
      if (clamped.length > 0) {
        db.run("UPDATE tasks SET due_at = ?, updated_at = ? WHERE board_id = ? AND datetime(due_at) > datetime(?)", [
          newEndsAt,
          new Date().toISOString(),
          boardId,
          newEndsAt,
        ]);
        changed.clampedTasks = clamped.length;
        log.warn("task due dates clamped to new board deadline", {
          boardId,
          count: clamped.length,
          endsAt: newEndsAt,
        });
      }
    }

    record(db, actor, "board.updated", { boardId }, changed);
  });

  log.info("board updated", { boardId, changed, actor: actor.actorId, source: actor.source, requestId: actor.requestId });
  return getBoardDetail(boardId);
}

export function deleteBoard(boardId: string, actor: ActorContext): { id: string; deletedTasks: number } {
  const board = getBoard(boardId);
  const deletedTasks = getDb()
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM tasks WHERE board_id = ?")
    .get(boardId)?.count ?? 0;

  write((db) => {
    record(db, actor, "board.deleted", { boardId }, { name: board.name, deletedTasks });
    // Columns, tasks and comments go with it via ON DELETE CASCADE.
    db.run("DELETE FROM boards WHERE id = ?", [boardId]);
  });

  log.warn("board deleted", { boardId, name: board.name, deletedTasks, actor: actor.actorId, source: actor.source });
  return { id: boardId, deletedTasks };
}

/** Rejects a due date that falls outside the board's window. */
export function assertDueWithinBoard(board: Board, dueAt: string): void {
  const due = parseDate(dueAt, "dueAt").getTime();
  const end = new Date(board.endsAt).getTime();
  if (due > end) {
    throw badRequest(
      `dueAt is after this board's deadline — every task on "${board.name}" must finish by ${board.endsAt}`,
      { dueAt, boardEndsAt: board.endsAt },
    );
  }
}
