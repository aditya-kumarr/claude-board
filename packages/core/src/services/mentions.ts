import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toMention, toResolvedProject, type MentionRow, type ProjectContextRow } from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { mentionedHandles, requestText } from "../lib/mentions.ts";
import {
  OPEN_MENTION_STATUSES,
  USER_CLAUDE,
  type Mention,
  type MentionStatus,
  type MentionWithContext,
  type Priority,
  type ColumnKind,
} from "../types.ts";
import { record } from "./activity.ts";
import { insertComment } from "./comments.ts";
import type { ActorContext } from "./context.ts";
import { PROJECT_CONTEXT_COLUMNS, PROJECT_CONTEXT_JOIN } from "./projects.ts";
import { listUsers, requireUser } from "./users.ts";

const log = createLogger("mentions");

/**
 * `@claude` in a comment is a request. This service is what makes that true
 * rather than decorative: every mention of an agent gets a row with a lifecycle,
 * so a note left from a phone at midnight is still waiting in the agent's inbox
 * in the morning instead of depending on someone having been in a session.
 *
 * Two rules keep the loop from feeding itself:
 *   - only agent-kind users get a mention row (mentioning the human is prose), and
 *   - an actor never enqueues a mention of itself, so Claude writing "@claude will
 *     follow up" is a note, not a new job.
 */

/** Handles that resolve to an agent, keyed lower-case. Small table, read per call. */
function agentHandles(): Map<string, string> {
  const handles = new Map<string, string>();
  for (const user of listUsers()) {
    if (user.kind !== "agent") continue;
    handles.set(user.id.toLowerCase(), user.id);
    handles.set(user.displayName.toLowerCase(), user.id);
  }
  // The conversational aliases `requireUser` already accepts, so "@you" reads
  // the same in a comment as it does in a tool argument.
  for (const alias of ["you", "agent", "assistant"]) {
    if (!handles.has(alias)) handles.set(alias, USER_CLAUDE);
  }
  return handles;
}

/**
 * Records a mention row for every agent named in `body`. Called inside the
 * caller's transaction, immediately after the comment it refers to is inserted,
 * so a mention can never exist without its request text.
 */
export function recordMentions(
  db: Database,
  target: { taskId: string; boardId: string; commentId: string },
  body: string,
  actor: ActorContext,
): Mention[] {
  const handles = agentHandles();
  const created: Mention[] = [];
  const createdAt = new Date().toISOString();

  const targeted = new Set<string>();
  for (const handle of mentionedHandles(body)) {
    const userId = handles.get(handle);
    // Unknown handle, a human, or the actor naming itself: not a request.
    if (!userId || userId === actor.actorId || targeted.has(userId)) continue;
    targeted.add(userId);

    const id = newId("men");
    db.run(
      `INSERT INTO task_mentions (id, task_id, board_id, comment_id, target_id, requested_by, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (comment_id, target_id) DO NOTHING`,
      [id, target.taskId, target.boardId, target.commentId, userId, actor.actorId, actor.source, createdAt],
    );
    record(db, actor, "mention.created", { boardId: target.boardId, taskId: target.taskId }, {
      mentionId: id,
      commentId: target.commentId,
      target: userId,
      request: requestText(body, handle).slice(0, 200),
    });
    created.push({
      id,
      taskId: target.taskId,
      boardId: target.boardId,
      commentId: target.commentId,
      targetId: userId,
      requestedBy: actor.actorId,
      status: "pending",
      source: actor.source,
      claimedAt: null,
      resolvedAt: null,
      resolution: null,
      createdAt,
    });
  }

  if (created.length > 0) {
    log.info("mention recorded", {
      taskId: target.taskId,
      commentId: target.commentId,
      targets: created.map((mention) => mention.targetId),
      actor: actor.actorId,
      source: actor.source,
      requestId: actor.requestId,
    });
  }
  return created;
}

type MentionContextRow = MentionRow &
  ProjectContextRow & {
    body: string;
    requested_by_name: string;
    task_title: string;
    task_description: string | null;
    task_assignee_id: string | null;
    task_priority: string;
    task_due_at: string | null;
    board_name: string;
    board_ends_at: string;
    column_key: string;
    column_name: string;
    column_kind: string;
  };

/**
 * One row per mention carrying the ask, the card and the board deadline. The
 * join is the point: an agent picking up a mention needs all three to act, and
 * a second round-trip per mention is how a queue turns into ten tool calls.
 */
const CONTEXT_SELECT = /* sql */ `
  SELECT m.*,
         cm.body                AS body,
         u.display_name         AS requested_by_name,
         t.title                AS task_title,
         t.description          AS task_description,
         t.assignee_id          AS task_assignee_id,
         t.priority             AS task_priority,
         t.due_at               AS task_due_at,
         b.name                 AS board_name,
         b.ends_at              AS board_ends_at,
         c.key                  AS column_key,
         c.name                 AS column_name,
         c.kind                 AS column_kind,
         -- The directory this request is to be carried out in, resolved card-first
         -- then board. Joined rather than looked up per row because it is what
         -- decides *where* the run answering the mention is spawned, and a queue
         -- of fifty asks must not become fifty extra queries to find that out.
         ${PROJECT_CONTEXT_COLUMNS}
    FROM task_mentions m
    JOIN task_comments cm ON cm.id = m.comment_id
    JOIN users u          ON u.id  = m.requested_by
    JOIN tasks t          ON t.id  = m.task_id
    JOIN boards b         ON b.id  = m.board_id
    JOIN board_columns c  ON c.id  = t.column_id
    ${PROJECT_CONTEXT_JOIN}
`;

/**
 * `handles` is threaded in so a list of 50 mentions reads the users table once.
 * The handle that matters is the one naming *this* row's target: a comment can
 * say "@claude ask @otherbot too", and each row's request starts at its own name.
 */
function toContext(row: MentionContextRow, handles: Map<string, string>): MentionWithContext {
  const mention = toMention(row);
  const handle =
    mentionedHandles(row.body).find((candidate) => handles.get(candidate) === row.target_id) ?? row.target_id;
  return {
    ...mention,
    body: row.body,
    request: requestText(row.body, handle),
    requestedByName: row.requested_by_name,
    taskTitle: row.task_title,
    taskDescription: row.task_description,
    taskAssigneeId: row.task_assignee_id,
    taskPriority: row.task_priority as Priority,
    taskDueAt: row.task_due_at,
    taskOverdue:
      row.column_kind !== "done" && row.task_due_at !== null && new Date(row.task_due_at).getTime() < Date.now(),
    boardName: row.board_name,
    boardEndsAt: row.board_ends_at,
    columnKey: row.column_key,
    columnName: row.column_name,
    columnKind: row.column_kind as ColumnKind,
    project: toResolvedProject(row),
  };
}

export interface ListMentionsFilter {
  /** Who was asked. Accepts the same aliases as an assignee. Defaults to Claude. */
  target?: string;
  /** Defaults to the open statuses (pending + claimed). */
  status?: MentionStatus | readonly MentionStatus[];
  boardId?: string;
  taskId?: string;
  /** Only mentions created after this ISO timestamp. */
  since?: string;
  includeArchivedBoards?: boolean;
  limit?: number;
}

/** Oldest first: a request queue is answered in the order it was asked. */
export function listMentions(filter: ListMentionsFilter = {}): MentionWithContext[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  where.push("m.target_id = ?");
  params.push(filter.target === undefined ? USER_CLAUDE : requireUser(filter.target).id);

  const statuses =
    filter.status === undefined
      ? OPEN_MENTION_STATUSES
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status as MentionStatus];
  if (statuses.length === 0) throw badRequest("status filter cannot be empty");
  where.push(`m.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);

  if (filter.boardId) {
    where.push("m.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.taskId) {
    where.push("m.task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.since) {
    where.push("datetime(m.created_at) > datetime(?)");
    params.push(filter.since);
  }
  if (!filter.includeArchivedBoards) where.push("b.archived = 0");

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const handles = agentHandles();
  return getDb()
    .query<MentionContextRow, SQLQueryBindings[]>(
      `${CONTEXT_SELECT} WHERE ${where.join(" AND ")} ORDER BY datetime(m.created_at) ASC LIMIT ?`,
    )
    .all(...params, limit)
    .map((row) => toContext(row, handles));
}

export function getMention(mentionId: string): MentionWithContext {
  const row = getDb()
    .query<MentionContextRow, [string]>(`${CONTEXT_SELECT} WHERE m.id = ?`)
    .get(mentionId);
  if (!row) throw notFound("mention", mentionId);
  return toContext(row, agentHandles());
}

/** How many unresolved requests are waiting, for a header or a banner. */
export function countOpenMentions(options: { target?: string; boardId?: string } = {}): number {
  const params: SQLQueryBindings[] = [options.target ? requireUser(options.target).id : USER_CLAUDE];
  let sql = `SELECT COUNT(*) AS count FROM task_mentions m JOIN boards b ON b.id = m.board_id
              WHERE m.target_id = ? AND m.status IN ('pending','claimed') AND b.archived = 0`;
  if (options.boardId) {
    sql += " AND m.board_id = ?";
    params.push(options.boardId);
  }
  return getDb().query<{ count: number }, SQLQueryBindings[]>(sql).get(...params)?.count ?? 0;
}

/**
 * Takes ownership of a pending mention so a second runner skips it. The read and
 * the write share one transaction, which is the lock — SQLite serialises writers,
 * so two watchers racing for the same mention cannot both win.
 */
export function claimMention(mentionId: string, actor: ActorContext): MentionWithContext {
  const before = getMention(mentionId);
  write((db) => {
    const current = db
      .query<{ status: string }, [string]>("SELECT status FROM task_mentions WHERE id = ?")
      .get(mentionId);
    if (!current) throw notFound("mention", mentionId);
    if (current.status === "answered" || current.status === "dismissed") {
      throw conflict(`mention ${mentionId} is already ${current.status}`, { mentionId, status: current.status });
    }
    if (current.status === "claimed") {
      throw conflict(`mention ${mentionId} is already claimed by another run`, { mentionId, status: "claimed" });
    }
    db.run("UPDATE task_mentions SET status = 'claimed', claimed_at = ? WHERE id = ?", [
      new Date().toISOString(),
      mentionId,
    ]);
    record(db, actor, "mention.claimed", { boardId: before.boardId, taskId: before.taskId }, { mentionId });
  });

  log.info("mention claimed", {
    mentionId,
    taskId: before.taskId,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return getMention(mentionId);
}

export interface ResolveMentionInput {
  /** `answered` when the ask was carried out, `dismissed` when deliberately not. */
  status?: Extract<MentionStatus, "answered" | "dismissed">;
  /** One line on what was done. Shown in the thread and the audit trail. */
  resolution: string;
  /**
   * Posted into the task's comment thread as the visible reply. Defaults to the
   * resolution text, because a request answered with nothing in the thread looks
   * to the human exactly like a request that was ignored.
   */
  reply?: string | null;
}

export function resolveMention(
  mentionId: string,
  input: ResolveMentionInput,
  actor: ActorContext,
): MentionWithContext {
  const mention = getMention(mentionId);
  const status = input.status ?? "answered";
  if (status !== "answered" && status !== "dismissed") {
    throw badRequest("status must be answered or dismissed", { received: status });
  }
  const resolution = input.resolution?.trim();
  if (!resolution) throw badRequest("resolution is required — say what you did about the request");
  if (resolution.length > 1000) throw badRequest("resolution must be 1000 characters or fewer");
  if (mention.status === "answered" || mention.status === "dismissed") {
    throw conflict(`mention ${mentionId} is already ${mention.status}`, {
      mentionId,
      status: mention.status,
      resolution: mention.resolution,
    });
  }

  // `null` is an explicit "do not post anything"; undefined means use the resolution.
  const reply = input.reply === null ? null : (input.reply ?? resolution).trim() || null;

  write((db) => {
    if (reply) insertComment(db, { taskId: mention.taskId, boardId: mention.boardId }, reply, actor);
    db.run("UPDATE task_mentions SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?", [
      status,
      new Date().toISOString(),
      resolution,
      mentionId,
    ]);
    record(db, actor, "mention.resolved", { boardId: mention.boardId, taskId: mention.taskId }, {
      mentionId,
      status,
      resolution,
      replied: reply !== null,
    });
  });

  log.info("mention resolved", {
    mentionId,
    taskId: mention.taskId,
    status,
    replied: reply !== null,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return getMention(mentionId);
}

/**
 * Puts a claimed mention back in the queue. The watcher calls this when a run
 * dies without resolving, so a crash costs a retry rather than the request.
 */
export function releaseMention(mentionId: string, reason: string, actor: ActorContext): MentionWithContext {
  const mention = getMention(mentionId);
  if (mention.status !== "claimed") {
    throw conflict(`mention ${mentionId} is ${mention.status}, not claimed`, { mentionId, status: mention.status });
  }
  write((db) => {
    db.run("UPDATE task_mentions SET status = 'pending', claimed_at = NULL WHERE id = ?", [mentionId]);
    record(db, actor, "mention.released", { boardId: mention.boardId, taskId: mention.taskId }, {
      mentionId,
      reason,
    });
  });
  log.warn("mention released back to pending", { mentionId, taskId: mention.taskId, reason, actor: actor.actorId });
  return getMention(mentionId);
}
