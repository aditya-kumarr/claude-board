import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toTask, toResolvedProject, type ProjectContextRow, type TaskRow } from "../db/rows.ts";
import { buildWindow, parseDate } from "../lib/duration.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import {
  PRIORITIES,
  type CommentKind,
  type Mention,
  type Priority,
  type ResolvedProject,
  type Task,
  type TaskComment,
} from "../types.ts";
import { record } from "./activity.ts";
import { assertDueWithinBoard, getBoard } from "./boards.ts";
import { getColumn, listColumns, resolveColumn } from "./columns.ts";
import { insertComment, listComments } from "./comments.ts";
import type { ActorContext } from "./context.ts";
import { listMentions, recordMentions } from "./mentions.ts";
import {
  PROJECT_CONTEXT_COLUMNS,
  PROJECT_CONTEXT_JOIN,
  requireProject,
  resolveProjectForTask,
} from "./projects.ts";
import { getTaskResponseSummary } from "./responses.ts";
import { positionAtIndex, positionForAppend } from "./positions.ts";
import { requireUser } from "./users.ts";

const log = createLogger("tasks");

function requireTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("title is required");
  if (value.trim().length > 300) throw badRequest("title must be 300 characters or fewer");
  return value.trim();
}

function requirePriority(value: unknown): Priority {
  if (value === undefined || value === null) return "medium";
  if (typeof value !== "string" || !(PRIORITIES as readonly string[]).includes(value)) {
    throw badRequest(`priority must be one of ${PRIORITIES.join(", ")}`, { received: value });
  }
  return value as Priority;
}

export function getTask(taskId: string): Task {
  const row = getDb().query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!row) throw notFound("task", taskId);
  return toTask(row);
}

/** Enforces a column's WIP limit before a card lands in it. */
function assertWipLimit(columnId: string, excludeTaskId?: string): void {
  const column = getColumn(columnId);
  if (column.wipLimit === null) return;
  const count =
    getDb()
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM tasks WHERE column_id = ? AND id != ?",
      )
      .get(columnId, excludeTaskId ?? "")?.count ?? 0;
  if (count >= column.wipLimit) {
    throw conflict(`column "${column.name}" is at its WIP limit of ${column.wipLimit}`, {
      columnId,
      wipLimit: column.wipLimit,
      current: count,
    });
  }
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  /** Column id, key or name. Defaults to the board's leftmost column. */
  column?: string;
  assignee?: string | null;
  priority?: Priority | string;
  /** Must fall within the board's window; defaults to the board deadline. */
  dueAt?: string | null;
  blockedReason?: string | null;
  /**
   * Directory this card's work happens in — an id, slug, name or path. Omit it and
   * the card inherits its board's project, which is the usual case: an override is
   * for the odd card that belongs to a different checkout than the rest of the board.
   */
  project?: string | null;
  /**
   * Natural key of what this card was imported from, e.g. `outlook:AAMkAD...`.
   * Unique per board: importing the same message twice is rejected as a conflict
   * rather than producing a second card, which is what makes a sync re-runnable.
   */
  sourceRef?: string | null;
}

export function createTask(boardId: string, input: CreateTaskInput, actor: ActorContext): Task {
  const board = getBoard(boardId);
  if (board.archived) throw conflict("cannot add tasks to an archived board", { boardId });

  const title = requireTitle(input.title);
  const priority = requirePriority(input.priority);
  const columns = listColumns(boardId);
  if (columns.length === 0) throw conflict("this board has no columns", { boardId });
  const column = input.column ? resolveColumn(boardId, input.column) : columns[0]!;

  const assigneeId = input.assignee ? requireUser(input.assignee).id : null;
  const projectId = input.project ? requireProject(input.project).id : null;

  // Unset due dates inherit the board's deadline: the board's duration *is* the
  // implicit commitment for everything on it.
  let dueAt = board.endsAt;
  if (input.dueAt === null) dueAt = board.endsAt;
  else if (input.dueAt !== undefined) {
    const parsed = parseDate(input.dueAt, "dueAt");
    assertDueWithinBoard(board, parsed.toISOString());
    if (parsed.getTime() < new Date(board.startsAt).getTime()) {
      throw badRequest(`dueAt is before this board's window starts (${board.startsAt})`, { dueAt: input.dueAt });
    }
    dueAt = parsed.toISOString();
  }

  assertWipLimit(column.id);

  const sourceRef = input.sourceRef?.trim() || null;
  if (sourceRef) {
    if (sourceRef.length > 400) throw badRequest("sourceRef must be 400 characters or fewer");
    const existing = getDb()
      .query<{ id: string; title: string }, [string, string]>(
        "SELECT id, title FROM tasks WHERE board_id = ? AND source_ref = ?",
      )
      .get(boardId, sourceRef);
    // Checked up front so the caller gets the existing card's id, which a bare
    // UNIQUE violation would not tell them.
    if (existing) {
      throw conflict(`this board already has a task imported from ${sourceRef}`, {
        sourceRef,
        existingTaskId: existing.id,
        existingTitle: existing.title,
      });
    }
  }

  const id = newId("tsk");
  const now = new Date().toISOString();
  write((db) => {
    db.run(
      `INSERT INTO tasks (id, board_id, column_id, title, description, assignee_id, created_by, priority,
                          due_at, position, completed_at, blocked_reason, project_id, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        boardId,
        column.id,
        title,
        input.description?.trim() || null,
        assigneeId,
        actor.actorId,
        priority,
        dueAt,
        positionForAppend(db, column.id),
        column.kind === "done" ? now : null,
        input.blockedReason?.trim() || null,
        projectId,
        sourceRef,
        now,
        now,
      ],
    );
    record(db, actor, "task.created", { boardId, taskId: id }, {
      title,
      column: column.key,
      assignee: assigneeId,
      priority,
      dueAt,
      project: projectId,
      sourceRef,
    });
  });

  log.info("task created", {
    taskId: id,
    boardId,
    column: column.key,
    assignee: assigneeId,
    priority,
    dueAt,
    sourceRef,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return getTask(id);
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: Priority | string;
  dueAt?: string | null;
  blockedReason?: string | null;
  /**
   * `null` does not mean "no project": it clears this card's override, so the
   * card falls back to its board's. That is the only way to un-override one.
   */
  project?: string | null;
}

export function updateTask(taskId: string, input: UpdateTaskInput, actor: ActorContext): Task {
  const task = getTask(taskId);
  const board = getBoard(task.boardId);
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const changed: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = requireTitle(input.title);
    sets.push("title = ?");
    params.push(title);
    changed.title = title;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    sets.push("description = ?");
    params.push(description);
    changed.description = description === null ? null : `${description.slice(0, 60)}…`;
  }
  if (input.assignee !== undefined) {
    const assigneeId = input.assignee === null ? null : requireUser(input.assignee).id;
    sets.push("assignee_id = ?");
    params.push(assigneeId);
    changed.assignee = assigneeId;
  }
  if (input.priority !== undefined) {
    const priority = requirePriority(input.priority);
    sets.push("priority = ?");
    params.push(priority);
    changed.priority = priority;
  }
  if (input.dueAt !== undefined) {
    // Clearing a due date falls back to the board deadline, never to "no deadline".
    const dueAt = input.dueAt === null ? board.endsAt : parseDate(input.dueAt, "dueAt").toISOString();
    assertDueWithinBoard(board, dueAt);
    sets.push("due_at = ?");
    params.push(dueAt);
    changed.dueAt = dueAt;
  }
  if (input.blockedReason !== undefined) {
    const reason = input.blockedReason?.trim() || null;
    sets.push("blocked_reason = ?");
    params.push(reason);
    changed.blockedReason = reason;
  }
  if (input.project !== undefined) {
    const projectId = input.project === null ? null : requireProject(input.project).id;
    sets.push("project_id = ?");
    params.push(projectId);
    changed.project = projectId;
  }

  if (sets.length === 0) return task;

  write((db) => {
    db.run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
      ...params,
      new Date().toISOString(),
      taskId,
    ]);
    record(db, actor, "task.updated", { boardId: task.boardId, taskId }, changed);
  });

  log.info("task updated", { taskId, boardId: task.boardId, changed, actor: actor.actorId, source: actor.source });
  return getTask(taskId);
}

export interface MoveTaskInput {
  /** Target column id, key or name. */
  column: string;
  /** Zero-based slot within the target column; appended when omitted. */
  index?: number;
  /** Recorded when moving into a blocked-kind column. */
  blockedReason?: string | null;
  /** Bypass the target column's WIP limit. */
  force?: boolean;
}

export function moveTask(taskId: string, input: MoveTaskInput, actor: ActorContext): Task {
  const task = getTask(taskId);
  const from = getColumn(task.columnId);
  const to = resolveColumn(task.boardId, input.column);

  if (to.id !== from.id && !input.force) assertWipLimit(to.id, taskId);

  const now = new Date().toISOString();
  // Entering a done column stamps completion; leaving one clears it, so a card
  // reopened for rework stops counting as finished.
  const completedAt = to.kind === "done" ? task.completedAt ?? now : null;
  const blockedReason =
    input.blockedReason !== undefined
      ? input.blockedReason?.trim() || null
      : to.kind === "blocked"
        ? task.blockedReason
        : null;

  write((db) => {
    const position = positionAtIndex(db, to.id, input.index ?? Number.MAX_SAFE_INTEGER, taskId);
    db.run(
      `UPDATE tasks SET column_id = ?, position = ?, completed_at = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`,
      [to.id, position, completedAt, blockedReason, now, taskId],
    );
    record(db, actor, "task.moved", { boardId: task.boardId, taskId }, {
      from: from.key,
      to: to.key,
      index: input.index ?? null,
      blockedReason,
    });
  });

  log.info("task moved", {
    taskId,
    boardId: task.boardId,
    from: from.key,
    to: to.key,
    completed: completedAt !== null,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return getTask(taskId);
}

export function deleteTask(taskId: string, actor: ActorContext): { id: string } {
  const task = getTask(taskId);
  write((db) => {
    record(db, actor, "task.deleted", { boardId: task.boardId, taskId }, { title: task.title });
    db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
  });
  log.warn("task deleted", { taskId, boardId: task.boardId, title: task.title, actor: actor.actorId });
  return { id: taskId };
}

export interface ListTasksFilter {
  boardId?: string;
  assignee?: string | null;
  column?: string;
  columnKind?: string;
  priority?: string;
  /** Only unfinished tasks past their due date. */
  overdueOnly?: boolean;
  /** Excluded by default when filtering an agent's work queue. */
  includeDone?: boolean;
  includeArchivedBoards?: boolean;
  search?: string;
  /** Exact match on the import key, to check whether something is already on the board. */
  sourceRef?: string;
  limit?: number;
}

export interface TaskWithContext extends Task {
  boardName: string;
  boardEndsAt: string;
  columnKey: string;
  columnName: string;
  columnKind: string;
  overdue: boolean;
  /**
   * Where this card's work happens, resolved through its board. Free here — the
   * query already joins both — and it is the field that tells a cross-board queue
   * which codebase each line belongs to.
   */
  project: ResolvedProject | null;
}

/**
 * The one read path used by the API, the UI's filters and the agent's queue.
 * Joins board and column context because a task id alone is not actionable.
 */
export function listTasks(filter: ListTasksFilter = {}): TaskWithContext[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.boardId) {
    where.push("t.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.assignee !== undefined) {
    if (filter.assignee === null) where.push("t.assignee_id IS NULL");
    else {
      where.push("t.assignee_id = ?");
      params.push(requireUser(filter.assignee).id);
    }
  }
  if (filter.column && filter.boardId) {
    where.push("t.column_id = ?");
    params.push(resolveColumn(filter.boardId, filter.column).id);
  }
  if (filter.columnKind) {
    where.push("c.kind = ?");
    params.push(filter.columnKind);
  }
  if (filter.priority) {
    where.push("t.priority = ?");
    params.push(requirePriority(filter.priority));
  }
  if (!filter.includeDone) where.push("c.kind != 'done'");
  if (!filter.includeArchivedBoards) where.push("b.archived = 0");
  if (filter.overdueOnly) where.push("t.due_at IS NOT NULL AND datetime(t.due_at) < datetime('now')");
  if (filter.sourceRef) {
    where.push("t.source_ref = ?");
    params.push(filter.sourceRef);
  }
  if (filter.search) {
    where.push("(t.title LIKE ? OR IFNULL(t.description,'') LIKE ?)");
    const pattern = `%${filter.search.trim()}%`;
    params.push(pattern, pattern);
  }

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = getDb()
    .query<
      TaskRow &
        ProjectContextRow & {
          board_name: string;
          board_ends_at: string;
          column_key: string;
          column_name: string;
          column_kind: string;
        },
      SQLQueryBindings[]
    >(
      `SELECT t.*, b.name AS board_name, b.ends_at AS board_ends_at,
              c.key AS column_key, c.name AS column_name, c.kind AS column_kind,
              ${PROJECT_CONTEXT_COLUMNS}
         FROM tasks t
         JOIN boards b        ON b.id = t.board_id
         JOIN board_columns c ON c.id = t.column_id
         ${PROJECT_CONTEXT_JOIN}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          datetime(IFNULL(t.due_at, b.ends_at)) ASC,
          t.position ASC
        LIMIT ?`,
    )
    .all(...params, limit);

  const now = Date.now();
  return rows.map((row) => ({
    ...toTask(row),
    boardName: row.board_name,
    boardEndsAt: row.board_ends_at,
    columnKey: row.column_key,
    columnName: row.column_name,
    columnKind: row.column_kind,
    overdue: row.column_kind !== "done" && row.due_at !== null && new Date(row.due_at).getTime() < now,
    project: toResolvedProject(row),
  }));
}

export interface AddCommentResult {
  comment: TaskComment;
  /** Requests this comment raised by naming an agent. Empty for ordinary notes. */
  mentions: Mention[];
}

/**
 * Appends a comment and promotes any `@agent` in it to a tracked request. The
 * parse happens here, in the one write path both transports share, so a note
 * left in the web UI and a note left over MCP raise a request identically.
 */
export function addCommentWithMentions(
  taskId: string,
  body: string,
  actor: ActorContext,
  kind: CommentKind = "note",
): AddCommentResult {
  const task = getTask(taskId);
  const target = { taskId, boardId: task.boardId };

  const result = write((db) => {
    const comment = insertComment(db, target, body, actor, kind);
    // Parsed for every kind, not just notes: the guard that an actor never
    // enqueues a mention of itself already makes Claude's own narration inert,
    // and skipping the parse here would silently drop a genuine "@claude" that
    // one agent left for another in a progress note.
    const mentions = recordMentions(db, { ...target, commentId: comment.id }, comment.body, actor);
    return { comment, mentions };
  });

  log.info("comment added", {
    taskId,
    commentId: result.comment.id,
    kind,
    mentions: result.mentions.length,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return result;
}

/** Comment-only view of the above, for callers that do not care about mentions. */
export function addComment(
  taskId: string,
  body: string,
  actor: ActorContext,
  kind: CommentKind = "note",
): TaskComment {
  return addCommentWithMentions(taskId, body, actor, kind).comment;
}

/** Task plus everything needed to act on it without further lookups. */
export function getTaskDetail(taskId: string) {
  const task = getTask(taskId);
  const board = getBoard(task.boardId);
  const column = getColumn(task.columnId);
  return {
    task,
    board,
    column,
    /**
     * Where work on this card happens, already resolved through the board. A card
     * that reads as "fix the duplicate button" is only actionable with it.
     */
    project: resolveProjectForTask(taskId),
    window: buildWindow(board.durationKind, board.startsAt, board.endsAt),
    comments: listComments(taskId),
    /** Unresolved asks in this thread — the reason to read the card right now. */
    openMentions: listMentions({ taskId, limit: 20 }),
    /**
     * The replies this card owes. Embedded rather than fetched separately because
     * a card imported from a mail is not actionable without them: the message the
     * user has to send back is half of what the card is for.
     */
    responses: getTaskResponseSummary(taskId),
    overdue: column.kind !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now(),
  };
}
