import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import {
  toResponse,
  toResponseTurn,
  type ResponseRow,
  type ResponseTurnRow,
} from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import {
  OPEN_RESPONSE_STATUSES,
  OPEN_RESPONSE_TURN_STATUSES,
  RESPONSE_CHANNELS,
  RESPONSE_ORIGINS,
  RESPONSE_STAGES,
  RESPONSE_STATUSES,
  type BoardResponseCount,
  type ColumnKind,
  type ResponseChannel,
  type ResponseOrigin,
  type ResponseStage,
  type ResponseStatus,
  type ResponseTurn,
  type ResponseTurnStatus,
  type ResponseTurnWithContext,
  type ResponseWithContext,
  type TaskResponse,
  type TaskResponseSummary,
} from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

const log = createLogger("responses");

/**
 * Draft replies for the cards a sync brings in.
 *
 * A card imported from Outlook or Teams exists because somebody is waiting on the
 * user, so the card on its own is half the job: the other half is the message they
 * owe back. This module holds those messages as drafts, two per correspondent —
 * one to send now, one to send once the work is actually done.
 *
 * The rule that everything else hangs off: **nothing here ever sends anything.**
 * No Graph write scope, no send tool in any watcher's allowlist, no code path that
 * posts. `sent` is the human recording that *they* sent it. The value of the
 * feature is having the words ready at the moment they are needed; making an
 * unattended process able to mail the user's colleagues is pure downside.
 *
 * Two structural notes:
 *
 *   - `response_turns` is the queue *and* the chat transcript, because they are the
 *     same thing seen at two moments. A pending turn is work waiting for an agent
 *     run; a finished one is a message in the thread the user reads. That is also
 *     why a manual edit is inserted as a turn that is already `done` — the history
 *     the user scrolls is one list, not two interleaved ones.
 *   - like `services/sync.ts`, this module reads the task fields it needs with its
 *     own query rather than importing `getTask`. `getTaskDetail` embeds a card's
 *     replies, so importing the task service here would close a cycle.
 */

const MAX_BODY = 20_000;
const MAX_SUBJECT = 300;
const MAX_INSTRUCTION = 2_000;
const MAX_NOTE = 2_000;
const MAX_CC = 20;

/* ------------------------------------------------------------------ validation */

function requireChannel(value: unknown): ResponseChannel {
  if (typeof value !== "string" || !(RESPONSE_CHANNELS as readonly string[]).includes(value)) {
    throw badRequest(`channel must be one of ${RESPONSE_CHANNELS.join(", ")}`, { received: value });
  }
  return value as ResponseChannel;
}

function requireStage(value: unknown): ResponseStage {
  if (typeof value !== "string" || !(RESPONSE_STAGES as readonly string[]).includes(value)) {
    throw badRequest(`stage must be one of ${RESPONSE_STAGES.join(", ")}`, { received: value });
  }
  return value as ResponseStage;
}

function requireStatus(value: unknown): ResponseStatus {
  if (typeof value !== "string" || !(RESPONSE_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(`status must be one of ${RESPONSE_STATUSES.join(", ")}`, { received: value });
  }
  return value as ResponseStatus;
}

function requireOrigin(value: unknown): ResponseOrigin {
  if (typeof value !== "string" || !(RESPONSE_ORIGINS as readonly string[]).includes(value)) {
    throw badRequest(`source must be one of ${RESPONSE_ORIGINS.join(", ")}`, { received: value });
  }
  return value as ResponseOrigin;
}

function requireBody(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("body is required — write the message");
  if (value.length > MAX_BODY) throw badRequest(`body must be ${MAX_BODY} characters or fewer`);
  // Only the ends are trimmed: the shape of a message is content, so internal
  // blank lines between paragraphs and a signature survive.
  return value.trim();
}

function requireInstruction(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${what} is required`);
  const text = value.trim();
  if (text.length > MAX_INSTRUCTION) throw badRequest(`${what} must be ${MAX_INSTRUCTION} characters or fewer`);
  return text;
}

function requireNote(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("note is required — say what you changed, in one line the user will read");
  }
  const text = value.trim();
  if (text.length > MAX_NOTE) throw badRequest(`note must be ${MAX_NOTE} characters or fewer`);
  return text;
}

function normaliseCc(value: unknown, channel: ResponseChannel): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest("cc must be an array of addresses", { received: value });
  const entries = [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
  if (entries.length > MAX_CC) throw badRequest(`cc must name ${MAX_CC} addresses or fewer`);
  // A Teams message has no cc field; silently accepting one would mean the UI
  // showing recipients that cannot receive it.
  if (entries.length > 0 && channel !== "email") {
    throw badRequest("cc only applies to an email — a chat message has no cc line", { channel });
  }
  return entries;
}

/**
 * Subject is email-only. A chat message that carried one would render a subject
 * line into a Teams box, so it is rejected rather than dropped: the caller has
 * misunderstood which channel it is writing for.
 */
function resolveSubject(
  value: unknown,
  channel: ResponseChannel,
  fallbackTitle: string,
): string | null {
  if (channel === "chat") {
    if (typeof value === "string" && value.trim() !== "") {
      throw badRequest("a chat message has no subject line — leave subject unset for channel=chat");
    }
    return null;
  }
  const text = typeof value === "string" && value.trim() !== "" ? value.trim() : `Re: ${fallbackTitle}`;
  if (text.length > MAX_SUBJECT) throw badRequest(`subject must be ${MAX_SUBJECT} characters or fewer`);
  return text;
}

/* ---------------------------------------------------------------- task context */

interface ResponseTask {
  id: string;
  boardId: string;
  title: string;
  sourceRef: string | null;
  columnKind: ColumnKind;
  archived: boolean;
}

/** The task fields a draft needs, read directly to keep this module a leaf. */
function responseTask(taskId: string): ResponseTask {
  const row = getDb()
    .query<
      { id: string; board_id: string; title: string; source_ref: string | null; column_kind: string; archived: number },
      [string]
    >(
      `SELECT t.id, t.board_id, t.title, t.source_ref, c.kind AS column_kind, b.archived
         FROM tasks t
         JOIN board_columns c ON c.id = t.column_id
         JOIN boards b        ON b.id = t.board_id
        WHERE t.id = ?`,
    )
    .get(taskId);
  if (!row) throw notFound("task", taskId);
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    sourceRef: row.source_ref,
    columnKind: row.column_kind as ColumnKind,
    archived: row.archived === 1,
  };
}

/**
 * Which channel a card's replies default to, taken from what it was imported
 * from. Mail is answered with mail and a Teams message with a Teams message, so
 * making the caller state the obvious is just a chance to get it wrong.
 */
function inferChannel(sourceRef: string | null): ResponseChannel {
  return sourceRef?.startsWith("teams:") ? "chat" : "email";
}

function inferOrigin(sourceRef: string | null): ResponseOrigin {
  if (sourceRef?.startsWith("outlook:")) return "outlook";
  if (sourceRef?.startsWith("teams:")) return "teams";
  return "manual";
}

/* ---------------------------------------------------------------------- reads */

type ResponseContextRow = ResponseRow & {
  task_title: string;
  task_description: string | null;
  task_source_ref: string | null;
  task_due_at: string | null;
  task_completed_at: string | null;
  column_key: string;
  column_name: string;
  column_kind: string;
  board_name: string;
  board_ends_at: string;
};

const CONTEXT_SELECT = /* sql */ `
  SELECT r.*,
         t.title        AS task_title,
         t.description  AS task_description,
         t.source_ref   AS task_source_ref,
         t.due_at       AS task_due_at,
         t.completed_at AS task_completed_at,
         c.key          AS column_key,
         c.name         AS column_name,
         c.kind         AS column_kind,
         b.name         AS board_name,
         b.ends_at      AS board_ends_at
    FROM task_responses r
    JOIN tasks t         ON t.id = r.task_id
    JOIN board_columns c ON c.id = t.column_id
    JOIN boards b        ON b.id = r.board_id
`;

/**
 * Whether this draft is the one to send now. An `acknowledge` reply always is; a
 * `completion` reply only once the card has actually reached a done-kind column,
 * which is the entire reason the two are separate drafts rather than one.
 */
function isDueNow(stage: ResponseStage, status: ResponseStatus, columnKind: ColumnKind): boolean {
  if (status === "sent" || status === "discarded") return false;
  return stage === "acknowledge" || columnKind === "done";
}

function toContext(row: ResponseContextRow, turns: ResponseTurn[]): ResponseWithContext {
  const response = toResponse(row);
  const columnKind = row.column_kind as ColumnKind;
  return {
    ...response,
    taskTitle: row.task_title,
    taskDescription: row.task_description,
    taskSourceRef: row.task_source_ref,
    taskDueAt: row.task_due_at,
    taskCompletedAt: row.task_completed_at,
    columnKey: row.column_key,
    columnName: row.column_name,
    columnKind,
    boardName: row.board_name,
    boardEndsAt: row.board_ends_at,
    dueNow: isDueNow(response.stage, response.status, columnKind),
    turns,
    activeTurn: turns.find((turn) => OPEN_RESPONSE_TURN_STATUSES.includes(turn.status)) ?? null,
  };
}

/**
 * Turns for a set of drafts, in one query. A per-draft lookup would mean a card
 * with six replies costing seven reads to render one panel.
 */
function turnsByResponse(responseIds: string[]): Map<string, ResponseTurn[]> {
  const byResponse = new Map<string, ResponseTurn[]>();
  if (responseIds.length === 0) return byResponse;
  const rows = getDb()
    .query<ResponseTurnRow, SQLQueryBindings[]>(
      `SELECT * FROM response_turns
        WHERE response_id IN (${responseIds.map(() => "?").join(", ")})
        ORDER BY datetime(created_at) ASC, rowid ASC`,
    )
    .all(...responseIds);
  for (const row of rows) {
    const turn = toResponseTurn(row);
    const list = byResponse.get(turn.responseId!) ?? [];
    list.push(turn);
    byResponse.set(turn.responseId!, list);
  }
  return byResponse;
}

export interface ListResponsesFilter {
  taskId?: string;
  boardId?: string;
  channel?: ResponseChannel | string;
  stage?: ResponseStage | string;
  /** Defaults to the open ones (draft + approved). Pass explicitly for history. */
  status?: ResponseStatus | readonly ResponseStatus[];
  /** Only drafts that are the user's to send right now. */
  dueNowOnly?: boolean;
  includeArchivedBoards?: boolean;
  limit?: number;
}

export function listResponses(filter: ListResponsesFilter = {}): ResponseWithContext[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.taskId) {
    where.push("r.task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.boardId) {
    where.push("r.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.channel) {
    where.push("r.channel = ?");
    params.push(requireChannel(filter.channel));
  }
  if (filter.stage) {
    where.push("r.stage = ?");
    params.push(requireStage(filter.stage));
  }

  const statuses =
    filter.status === undefined
      ? OPEN_RESPONSE_STATUSES
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status as ResponseStatus];
  if (statuses.length === 0) throw badRequest("status filter cannot be empty");
  where.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses.map(requireStatus));

  if (!filter.includeArchivedBoards) where.push("b.archived = 0");

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = getDb()
    .query<ResponseContextRow, SQLQueryBindings[]>(
      `${CONTEXT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY CASE r.stage WHEN 'acknowledge' THEN 0 ELSE 1 END,
                 datetime(r.created_at) ASC, r.rowid ASC
        LIMIT ?`,
    )
    .all(...params, limit);

  const turns = turnsByResponse(rows.map((row) => row.id));
  const responses = rows.map((row) => toContext(row, turns.get(row.id) ?? []));
  return filter.dueNowOnly ? responses.filter((response) => response.dueNow) : responses;
}

export function getResponse(responseId: string): ResponseWithContext {
  const row = getDb()
    .query<ResponseContextRow, [string]>(`${CONTEXT_SELECT} WHERE r.id = ?`)
    .get(responseId);
  if (!row) throw notFound("response", responseId);
  return toContext(row, turnsByResponse([responseId]).get(responseId) ?? []);
}

/** Bare row, for the paths that only need the draft's own fields. */
function getResponseRow(responseId: string): TaskResponse {
  const row = getDb().query<ResponseRow, [string]>("SELECT * FROM task_responses WHERE id = ?").get(responseId);
  if (!row) throw notFound("response", responseId);
  return toResponse(row);
}

/** Everything a card's Replies section renders, in one read. */
export function getTaskResponseSummary(taskId: string): TaskResponseSummary {
  responseTask(taskId);
  const responses = listResponses({
    taskId,
    status: RESPONSE_STATUSES,
    includeArchivedBoards: true,
    limit: 200,
  });
  const [activeDraftTurn] = listResponseTurns({
    taskId,
    kind: "draft",
    status: OPEN_RESPONSE_TURN_STATUSES,
    oldestFirst: true,
    limit: 1,
  });
  return { responses, activeDraftTurn: activeDraftTurn ?? null };
}

/**
 * Per-card counts for a whole board. One grouped query rather than a read per
 * card, so the board payload can badge cards that have replies waiting.
 */
export function countBoardResponses(boardId: string): BoardResponseCount[] {
  const rows = getDb()
    .query<
      { task_id: string; stage: string; column_kind: string; open: number; working: number },
      [string]
    >(
      `SELECT r.task_id,
              r.stage,
              c.kind AS column_kind,
              COUNT(*) AS open,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM response_turns tn
                     WHERE tn.response_id = r.id AND tn.status IN ('pending','claimed')
                  ) THEN 1 ELSE 0 END) AS working
         FROM task_responses r
         JOIN tasks t         ON t.id = r.task_id
         JOIN board_columns c ON c.id = t.column_id
        WHERE r.board_id = ? AND r.status IN ('draft','approved')
        GROUP BY r.task_id, r.stage, c.kind`,
    )
    .all(boardId);

  const byTask = new Map<string, BoardResponseCount>();
  for (const row of rows) {
    const entry = byTask.get(row.task_id) ?? { taskId: row.task_id, open: 0, dueNow: 0, working: false };
    entry.open += row.open;
    // Same rule as `isDueNow`, applied to the group rather than the row.
    if (row.stage === "acknowledge" || row.column_kind === "done") entry.dueNow += row.open;
    if (row.working > 0) entry.working = true;
    byTask.set(row.task_id, entry);
  }
  return [...byTask.values()];
}

/* --------------------------------------------------------------------- writes */

export interface DraftResponseInput {
  /** Defaults to the channel the card was imported over: mail answers mail. */
  channel?: ResponseChannel | string;
  stage: ResponseStage | string;
  /** Display name of who it goes to, e.g. "Priya Sharma". */
  recipientName: string;
  /** Address or chat id. This is the slot key, so two drafts for one person collide. */
  recipientRef?: string | null;
  cc?: string[];
  /** Email only. Defaults to `Re: <task title>`; rejected for a chat message. */
  subject?: string | null;
  body: string;
  /** Defaults to whatever the card was imported from, else `manual`. */
  source?: ResponseOrigin | string;
  /** The message being replied to, e.g. `outlook:AAMk...`. */
  sourceRef?: string | null;
  status?: ResponseStatus | string;
}

/**
 * Writes one draft reply for a card.
 *
 * Called once per correspondent per stage, so a mail that needs a holding reply
 * now and a real answer when the work lands produces two rows. A second draft for
 * the same person at the same stage is a conflict naming the one that exists —
 * the same protection `tasks.source_ref` gives an import, and for the same reason:
 * a re-run must not quietly leave the user with two versions of one reply and no
 * way to tell which is current.
 */
export function draftResponse(taskId: string, input: DraftResponseInput, actor: ActorContext): TaskResponse {
  const task = responseTask(taskId);
  if (task.archived) throw conflict("cannot draft replies on an archived board", { boardId: task.boardId });

  const channel = input.channel ? requireChannel(input.channel) : inferChannel(task.sourceRef);
  const stage = requireStage(input.stage);
  const status = input.status ? requireStatus(input.status) : "draft";
  if (status === "sent") {
    throw badRequest("a new draft cannot start out sent — nothing here sends messages", { status });
  }

  const recipientName = String(input.recipientName ?? "").trim();
  if (!recipientName) throw badRequest("recipientName is required — say who this reply goes to");
  if (recipientName.length > 200) throw badRequest("recipientName must be 200 characters or fewer");

  const recipientRef = input.recipientRef?.trim() || null;
  if (recipientRef && recipientRef.length > 320) throw badRequest("recipientRef must be 320 characters or fewer");

  const cc = normaliseCc(input.cc, channel);
  const subject = resolveSubject(input.subject, channel, task.title);
  const body = requireBody(input.body);
  const source = input.source ? requireOrigin(input.source) : inferOrigin(task.sourceRef);
  const sourceRef = input.sourceRef?.trim() || task.sourceRef;

  if (recipientRef) {
    const existing = getDb()
      .query<{ id: string; stage: string }, [string, string, string, string]>(
        `SELECT id, stage FROM task_responses
          WHERE task_id = ? AND channel = ? AND recipient_ref = ? AND stage = ? AND status != 'discarded'`,
      )
      .get(taskId, channel, recipientRef, stage);
    // Checked up front so the caller gets the existing draft's id, which a bare
    // UNIQUE violation would not tell them.
    if (existing) {
      throw conflict(
        `this card already has a ${stage} ${channel} reply drafted for ${recipientName}`,
        { existingResponseId: existing.id, taskId, channel, stage, recipientRef },
      );
    }
  }

  const id = newId("rsp");
  const now = new Date().toISOString();
  write((db) => {
    db.run(
      `INSERT INTO task_responses (id, task_id, board_id, channel, stage, status, recipient_name, recipient_ref,
                                   cc, subject, body, source, source_ref, created_by, actor_source, revision,
                                   sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        id,
        taskId,
        task.boardId,
        channel,
        stage,
        status,
        recipientName,
        recipientRef,
        cc.length > 0 ? JSON.stringify(cc) : null,
        subject,
        body,
        source,
        sourceRef,
        actor.actorId,
        actor.source,
        now,
        now,
      ],
    );
    record(db, actor, "response.drafted", { boardId: task.boardId, taskId }, {
      responseId: id,
      channel,
      stage,
      recipient: recipientRef ?? recipientName,
      chars: body.length,
    });
  });

  log.info("response drafted", {
    responseId: id,
    taskId,
    boardId: task.boardId,
    channel,
    stage,
    recipient: recipientRef ?? recipientName,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return getResponseRow(id);
}

export interface UpdateResponseInput {
  recipientName?: string;
  recipientRef?: string | null;
  cc?: string[];
  subject?: string | null;
  body?: string;
  stage?: ResponseStage | string;
}

/**
 * Applies a content change to a draft inside the caller's transaction, bumping
 * `revision`. Shared by the manual editor and by an agent finishing a revise
 * turn, so a hand edit and a rewrite land through exactly the same door.
 */
function applyEdit(
  db: Database,
  response: TaskResponse,
  input: UpdateResponseInput,
  taskTitle: string,
): Record<string, unknown> {
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const changed: Record<string, unknown> = {};

  if (input.recipientName !== undefined) {
    const name = String(input.recipientName).trim();
    if (!name) throw badRequest("recipientName cannot be blank");
    sets.push("recipient_name = ?");
    params.push(name);
    changed.recipientName = name;
  }
  if (input.recipientRef !== undefined) {
    const ref = input.recipientRef?.trim() || null;
    sets.push("recipient_ref = ?");
    params.push(ref);
    changed.recipientRef = ref;
  }
  if (input.cc !== undefined) {
    const cc = normaliseCc(input.cc, response.channel);
    sets.push("cc = ?");
    params.push(cc.length > 0 ? JSON.stringify(cc) : null);
    changed.cc = cc;
  }
  if (input.subject !== undefined) {
    const subject = resolveSubject(input.subject, response.channel, taskTitle);
    sets.push("subject = ?");
    params.push(subject);
    changed.subject = subject;
  }
  if (input.body !== undefined) {
    const body = requireBody(input.body);
    sets.push("body = ?");
    params.push(body);
    changed.body = `${body.length} chars`;
  }
  if (input.stage !== undefined) {
    const stage = requireStage(input.stage);
    sets.push("stage = ?");
    params.push(stage);
    changed.stage = stage;
  }

  if (sets.length === 0) return changed;

  db.run(
    `UPDATE task_responses SET ${sets.join(", ")}, revision = revision + 1, updated_at = ? WHERE id = ?`,
    [...params, new Date().toISOString(), response.id],
  );
  return changed;
}

/**
 * The manual editor's write path.
 *
 * Records the change as a `done` turn as well, so the panel's history reads as one
 * conversation about this message: "make it warmer" → Claude's rewrite → "edited
 * by hand". Without that, a hand edit would silently replace text the thread still
 * claims Claude wrote.
 */
export function updateResponse(
  responseId: string,
  input: UpdateResponseInput,
  actor: ActorContext,
): TaskResponse {
  const response = getResponseRow(responseId);
  if (response.status === "sent") {
    throw conflict("this reply is already marked sent; editing it would not change what went out", { responseId });
  }
  const task = responseTask(response.taskId);

  const changed = write((db) => {
    const applied = applyEdit(db, response, input, task.title);
    if (Object.keys(applied).length === 0) return applied;

    const updated = db
      .query<{ subject: string | null; body: string }, [string]>(
        "SELECT subject, body FROM task_responses WHERE id = ?",
      )
      .get(responseId)!;
    const fields = Object.keys(applied).join(", ");
    db.run(
      `INSERT INTO response_turns (id, response_id, task_id, board_id, kind, instruction, status, requested_by,
                                   actor_source, attempts, note, result_subject, result_body, finished_at, created_at)
       VALUES (?, ?, ?, ?, 'edit', ?, 'done', ?, ?, 0, NULL, ?, ?, ?, ?)`,
      [
        newId("rtn"),
        responseId,
        response.taskId,
        response.boardId,
        `Edited by hand (${fields}).`,
        actor.actorId,
        actor.source,
        updated.subject,
        updated.body,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    record(db, actor, "response.edited", { boardId: response.boardId, taskId: response.taskId }, {
      responseId,
      changed: applied,
    });
    return applied;
  });

  log.info("response edited", {
    responseId,
    taskId: response.taskId,
    changed,
    actor: actor.actorId,
    source: actor.source,
  });
  return getResponseRow(responseId);
}

/** Status moves the user is allowed to make. `sent` is terminal on purpose. */
const STATUS_TRANSITIONS: Record<ResponseStatus, readonly ResponseStatus[]> = {
  draft: ["approved", "sent", "discarded"],
  approved: ["draft", "sent", "discarded"],
  sent: [],
  discarded: ["draft"],
};

/**
 * Moves a draft through its lifecycle. `sent` only ever means "the user sent this
 * themselves" — it is a record, not an action, and it is terminal because there is
 * no unsending a mail that has left.
 */
export function setResponseStatus(
  responseId: string,
  status: ResponseStatus | string,
  actor: ActorContext,
): TaskResponse {
  const response = getResponseRow(responseId);
  const next = requireStatus(status);
  if (next === response.status) return response;
  if (!STATUS_TRANSITIONS[response.status].includes(next)) {
    throw conflict(`a ${response.status} reply cannot become ${next}`, {
      responseId,
      status: response.status,
      requested: next,
    });
  }

  const now = new Date().toISOString();
  write((db) => {
    db.run("UPDATE task_responses SET status = ?, sent_at = ?, updated_at = ? WHERE id = ?", [
      next,
      next === "sent" ? now : null,
      now,
      responseId,
    ]);
    // A draft nobody will send should not leave a rewrite queued behind it.
    if (next === "sent" || next === "discarded") {
      db.run(
        `UPDATE response_turns SET status = 'cancelled', finished_at = ?, note = ?
          WHERE response_id = ? AND status IN ('pending','claimed')`,
        [now, `The reply was marked ${next}, so this change was no longer wanted.`, responseId],
      );
    }
    record(db, actor, "response.status", { boardId: response.boardId, taskId: response.taskId }, {
      responseId,
      from: response.status,
      to: next,
    });
  });

  log.info("response status changed", {
    responseId,
    taskId: response.taskId,
    from: response.status,
    to: next,
    actor: actor.actorId,
    source: actor.source,
  });
  return getResponseRow(responseId);
}

export function deleteResponse(responseId: string, actor: ActorContext): { id: string } {
  const response = getResponseRow(responseId);
  write((db) => {
    record(db, actor, "response.deleted", { boardId: response.boardId, taskId: response.taskId }, {
      responseId,
      channel: response.channel,
      stage: response.stage,
      recipient: response.recipientRef ?? response.recipientName,
    });
    db.run("DELETE FROM task_responses WHERE id = ?", [responseId]);
  });
  log.warn("response deleted", { responseId, taskId: response.taskId, actor: actor.actorId });
  return { id: responseId };
}

/* ---------------------------------------------------------------------- turns */

type TurnContextRow = ResponseTurnRow & {
  task_title: string;
  task_description: string | null;
  task_source_ref: string | null;
  task_due_at: string | null;
  column_key: string;
  column_name: string;
  column_kind: string;
  board_name: string;
  board_ends_at: string;
  requested_by_name: string;
};

const TURN_CONTEXT_SELECT = /* sql */ `
  SELECT n.*,
         t.title       AS task_title,
         t.description AS task_description,
         t.source_ref  AS task_source_ref,
         t.due_at      AS task_due_at,
         c.key         AS column_key,
         c.name        AS column_name,
         c.kind        AS column_kind,
         b.name        AS board_name,
         b.ends_at     AS board_ends_at,
         u.display_name AS requested_by_name
    FROM response_turns n
    JOIN tasks t         ON t.id = n.task_id
    JOIN board_columns c ON c.id = t.column_id
    JOIN boards b        ON b.id = n.board_id
    JOIN users u         ON u.id = n.requested_by
`;

const toTurnContext = (row: TurnContextRow): ResponseTurnWithContext => ({
  ...toResponseTurn(row),
  taskTitle: row.task_title,
  taskDescription: row.task_description,
  taskSourceRef: row.task_source_ref,
  taskDueAt: row.task_due_at,
  columnKey: row.column_key,
  columnName: row.column_name,
  columnKind: row.column_kind as ColumnKind,
  boardName: row.board_name,
  boardEndsAt: row.board_ends_at,
  requestedByName: row.requested_by_name,
  response: row.response_id ? getResponseRow(row.response_id) : null,
});

export interface ListResponseTurnsFilter {
  taskId?: string;
  boardId?: string;
  responseId?: string;
  kind?: "draft" | "revise" | "edit";
  /** Defaults to the open ones (pending + claimed). */
  status?: ResponseTurnStatus | readonly ResponseTurnStatus[];
  /** Oldest first, so a queue is worked in the order it was asked for. */
  oldestFirst?: boolean;
  includeArchivedBoards?: boolean;
  limit?: number;
}

export function listResponseTurns(filter: ListResponseTurnsFilter = {}): ResponseTurnWithContext[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.taskId) {
    where.push("n.task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.boardId) {
    where.push("n.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.responseId) {
    where.push("n.response_id = ?");
    params.push(filter.responseId);
  }
  if (filter.kind) {
    where.push("n.kind = ?");
    params.push(filter.kind);
  }

  const statuses =
    filter.status === undefined
      ? OPEN_RESPONSE_TURN_STATUSES
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status as ResponseTurnStatus];
  if (statuses.length === 0) throw badRequest("status filter cannot be empty");
  where.push(`n.status IN (${statuses.map(() => "?").join(", ")})`);
  params.push(...statuses);

  if (!filter.includeArchivedBoards) where.push("b.archived = 0");

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  // By time rather than by id: ids are random strings, so ordering by them would
  // make "the oldest queued turn" an arbitrary one.
  const direction = filter.oldestFirst ? "ASC" : "DESC";
  return getDb()
    .query<TurnContextRow, SQLQueryBindings[]>(
      `${TURN_CONTEXT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY datetime(n.created_at) ${direction}, n.rowid ${direction} LIMIT ?`,
    )
    .all(...params, limit)
    .map(toTurnContext);
}

export function getResponseTurn(turnId: string): ResponseTurnWithContext {
  const row = getDb().query<TurnContextRow, [string]>(`${TURN_CONTEXT_SELECT} WHERE n.id = ?`).get(turnId);
  if (!row) throw notFound("response turn", turnId);
  return toTurnContext(row);
}

export interface RequestTurnResult {
  turn: ResponseTurnWithContext;
  /** True when one was already outstanding and this call returned that one. */
  alreadyQueued: boolean;
}

/** Inserts a pending turn inside the caller's transaction. */
function insertTurn(
  db: Database,
  target: { responseId: string | null; taskId: string; boardId: string },
  kind: "draft" | "revise",
  instruction: string,
  actor: ActorContext,
): string {
  const id = newId("rtn");
  db.run(
    `INSERT INTO response_turns (id, response_id, task_id, board_id, kind, instruction, status, requested_by,
                                 actor_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      target.responseId,
      target.taskId,
      target.boardId,
      kind,
      instruction,
      actor.actorId,
      actor.source,
      new Date().toISOString(),
    ],
  );
  return id;
}

/**
 * Queues a rewrite of one draft.
 *
 * This is what the chat box under a message does. The API process cannot ask
 * Claude anything, so the ask is recorded and an agent run carries it out — the
 * same shape the Sync button lives with, and idempotent for the same reason:
 * sending a second instruction while the first is still in flight would have two
 * runs rewriting one message from the same starting text.
 */
export function requestResponseRevision(
  responseId: string,
  instruction: string,
  actor: ActorContext,
): RequestTurnResult {
  const response = getResponseRow(responseId);
  if (response.status === "sent" || response.status === "discarded") {
    throw conflict(`this reply is ${response.status}; there is nothing to revise`, {
      responseId,
      status: response.status,
    });
  }
  const text = requireInstruction(instruction, "instruction");

  const existing = listResponseTurns({
    responseId,
    status: OPEN_RESPONSE_TURN_STATUSES,
    oldestFirst: true,
    limit: 1,
  })[0];
  if (existing) return { turn: existing, alreadyQueued: true };

  const id = write((db) => {
    const turnId = insertTurn(
      db,
      { responseId, taskId: response.taskId, boardId: response.boardId },
      "revise",
      text,
      actor,
    );
    record(db, actor, "response.revision_requested", { boardId: response.boardId, taskId: response.taskId }, {
      responseId,
      turnId,
      instruction: text.slice(0, 200),
    });
    return turnId;
  });

  log.info("response revision requested", {
    turnId: id,
    responseId,
    taskId: response.taskId,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { turn: getResponseTurn(id), alreadyQueued: false };
}

const DEFAULT_DRAFT_INSTRUCTION =
  "Draft the replies this card needs: one to send now and one to send once the work is done.";

/**
 * Queues a first pass of drafts for a card. Normally unnecessary — a sync writes
 * them while it still has the message in front of it — so this is the path for a
 * card typed in by hand, or one whose drafts were discarded.
 */
export function requestResponseDrafts(
  taskId: string,
  instruction: string | undefined,
  actor: ActorContext,
): RequestTurnResult {
  const task = responseTask(taskId);
  if (task.archived) throw conflict("cannot draft replies on an archived board", { boardId: task.boardId });
  const text = instruction?.trim()
    ? requireInstruction(instruction, "instruction")
    : DEFAULT_DRAFT_INSTRUCTION;

  const existing = listResponseTurns({
    taskId,
    kind: "draft",
    status: OPEN_RESPONSE_TURN_STATUSES,
    oldestFirst: true,
    limit: 1,
  })[0];
  if (existing) return { turn: existing, alreadyQueued: true };

  const id = write((db) => {
    const turnId = insertTurn(db, { responseId: null, taskId, boardId: task.boardId }, "draft", text, actor);
    record(db, actor, "response.drafts_requested", { boardId: task.boardId, taskId }, {
      turnId,
      instruction: text.slice(0, 200),
    });
    return turnId;
  });

  log.info("response drafts requested", {
    turnId: id,
    taskId,
    boardId: task.boardId,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { turn: getResponseTurn(id), alreadyQueued: false };
}

/**
 * Takes a queued turn. Read and write share one transaction, which is the lock:
 * SQLite serialises writers, so two runners racing for the same turn cannot both
 * win and rewrite one message twice.
 */
export function claimResponseTurn(turnId: string, actor: ActorContext): ResponseTurnWithContext {
  const before = getResponseTurn(turnId);
  write((db) => {
    const current = db
      .query<{ status: string }, [string]>("SELECT status FROM response_turns WHERE id = ?")
      .get(turnId);
    if (!current) throw notFound("response turn", turnId);
    if (current.status !== "pending") {
      throw conflict(`response turn ${turnId} is ${current.status}, not pending`, {
        turnId,
        status: current.status,
      });
    }
    db.run("UPDATE response_turns SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ?", [
      new Date().toISOString(),
      turnId,
    ]);
    record(db, actor, "response.turn_claimed", { boardId: before.boardId, taskId: before.taskId }, {
      turnId,
      responseId: before.responseId,
      kind: before.kind,
    });
  });

  log.info("response turn claimed", {
    turnId,
    taskId: before.taskId,
    kind: before.kind,
    actor: actor.actorId,
    source: actor.source,
  });
  return getResponseTurn(turnId);
}

export interface CompleteResponseTurnInput {
  status?: Extract<ResponseTurnStatus, "done" | "failed">;
  /** One line the user reads in the thread: what changed, or why nothing did. */
  note: string;
  /** The rewritten message. Required to finish a `revise` turn successfully. */
  body?: string;
  /** New subject, for an email whose subject the instruction changed. */
  subject?: string | null;
}

/**
 * Closes out a turn, and for a `revise` writes the message it produced in the
 * same transaction — the turn and the text it created cannot disagree.
 *
 * Finishing a revise without a body is rejected rather than recorded as success:
 * the draft would keep its old text while the thread claimed it had been changed,
 * which is the one outcome the user cannot see and cannot act on.
 */
export function completeResponseTurn(
  turnId: string,
  input: CompleteResponseTurnInput,
  actor: ActorContext,
): ResponseTurnWithContext {
  const turn = getResponseTurn(turnId);
  if (!OPEN_RESPONSE_TURN_STATUSES.includes(turn.status)) {
    throw conflict(`response turn ${turnId} is already ${turn.status}`, {
      turnId,
      status: turn.status,
      note: turn.note,
    });
  }
  const status = input.status ?? "done";
  if (status !== "done" && status !== "failed") throw badRequest("status must be done or failed", { received: status });
  const note = requireNote(input.note);

  const hasBody = typeof input.body === "string" && input.body.trim() !== "";
  if (status === "done" && turn.kind === "revise" && !hasBody) {
    throw badRequest(
      "a revise turn must finish with the rewritten body — without it the draft keeps its old text while the thread says it changed",
      { turnId },
    );
  }
  if (hasBody && turn.kind === "draft") {
    throw badRequest(
      "a draft turn creates replies with response_draft; it has no single body of its own",
      { turnId },
    );
  }

  const finishedAt = new Date().toISOString();
  write((db) => {
    let resultSubject: string | null = null;
    let resultBody: string | null = null;

    if (status === "done" && turn.response && hasBody) {
      const response = turn.response;
      applyEdit(
        db,
        response,
        { body: input.body, ...(input.subject !== undefined ? { subject: input.subject } : {}) },
        turn.taskTitle,
      );
      const updated = db
        .query<{ subject: string | null; body: string }, [string]>(
          "SELECT subject, body FROM task_responses WHERE id = ?",
        )
        .get(response.id)!;
      resultSubject = updated.subject;
      resultBody = updated.body;
    }

    db.run(
      `UPDATE response_turns SET status = ?, note = ?, result_subject = ?, result_body = ?, finished_at = ?
        WHERE id = ?`,
      [status, note, resultSubject, resultBody, finishedAt, turnId],
    );
    record(db, actor, "response.turn_completed", { boardId: turn.boardId, taskId: turn.taskId }, {
      turnId,
      responseId: turn.responseId,
      kind: turn.kind,
      status,
      note,
      rewritten: resultBody !== null,
    });
  });

  log[status === "done" ? "info" : "warn"]("response turn completed", {
    turnId,
    taskId: turn.taskId,
    responseId: turn.responseId,
    kind: turn.kind,
    status,
    actor: actor.actorId,
    source: actor.source,
  });
  return getResponseTurn(turnId);
}

/**
 * Puts a claimed turn back in the queue. The watcher calls this when a run dies
 * without finishing, so a crash costs a retry rather than the instruction.
 */
export function releaseResponseTurn(turnId: string, reason: string, actor: ActorContext): ResponseTurnWithContext {
  const turn = getResponseTurn(turnId);
  if (turn.status !== "claimed") {
    throw conflict(`response turn ${turnId} is ${turn.status}, not claimed`, { turnId, status: turn.status });
  }
  write((db) => {
    db.run("UPDATE response_turns SET status = 'pending', claimed_at = NULL WHERE id = ?", [turnId]);
    record(db, actor, "response.turn_released", { boardId: turn.boardId, taskId: turn.taskId }, { turnId, reason });
  });
  log.warn("response turn released back to pending", { turnId, taskId: turn.taskId, reason });
  return getResponseTurn(turnId);
}

/**
 * Drops a queued or claimed turn. Needed because the composer is disabled while a
 * change is in flight, so a turn left behind by a dead process would otherwise
 * wedge the message with no way back.
 */
export function cancelResponseTurn(turnId: string, reason: string, actor: ActorContext): ResponseTurnWithContext {
  const turn = getResponseTurn(turnId);
  if (!OPEN_RESPONSE_TURN_STATUSES.includes(turn.status)) {
    throw conflict(`response turn ${turnId} is already ${turn.status}`, { turnId, status: turn.status });
  }
  write((db) => {
    db.run("UPDATE response_turns SET status = 'cancelled', note = ?, finished_at = ? WHERE id = ?", [
      reason.trim() || "cancelled",
      new Date().toISOString(),
      turnId,
    ]);
    record(db, actor, "response.turn_cancelled", { boardId: turn.boardId, taskId: turn.taskId }, { turnId, reason });
  });
  log.warn("response turn cancelled", { turnId, taskId: turn.taskId, reason, actor: actor.actorId });
  return getResponseTurn(turnId);
}
