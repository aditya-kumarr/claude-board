import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { getDb, write } from "../db/index.ts";
import {
  toIntakeAttachment,
  toIntakeMessage,
  type IntakeAttachmentRow,
  type IntakeMessageRow,
} from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { INTAKE_DIR } from "../lib/paths.ts";
import {
  OPEN_INTAKE_STATUSES,
  type BoardIntakeSummary,
  type DurationKind,
  type IntakeAttachment,
  type IntakeAttachmentKind,
  type IntakeMessage,
  type IntakeMessageWithContext,
  type IntakeMessageWithFiles,
  type IntakeStatus,
} from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

const log = createLogger("intake");

/**
 * A chat on the board for turning raw material into cards.
 *
 * The premise is that the useful form of a plan is rarely a task list. It is a CSV
 * somebody exported, the notes from a call, a forwarded thread, a screenshot of a
 * whiteboard. This is where that goes: paste it, say what you want done with it,
 * and get cards back on the board it was pasted onto.
 *
 * Structurally it is `services/responses.ts` again, and deliberately so — the queue
 * and the transcript are one table, because a pending message is work and a
 * finished one is a message in the conversation the user scrolls. The Express
 * process has no model access, so pasting is genuinely all it can do.
 *
 * The one idea here that is not borrowed: **text is decoded at upload, not at read
 * time.** A CSV, a note, a log — anything text-bearing — is turned into a string in
 * this module and travels inline in the prompt. Only an image or a PDF leaves the
 * run something it has to open, and that is what decides its tool allowlist. So the
 * common case of pasting a spreadsheet export gives an unattended run no file
 * access at all, and a screenshot widens it by exactly one tool.
 *
 * Like `sync.ts` and `responses.ts` this reads the board fields it needs with its
 * own query: `getBoardDetail` embeds the intake summary, so importing the board
 * service here would close a cycle.
 */

const MAX_INSTRUCTION = 4_000;
/** Pasted text. Generous, because a CSV export is the whole point of the feature. */
const MAX_CONTENT = 400_000;
const MAX_NOTE = 4_000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Per text attachment. Past this the prompt stops being usable anyway. */
const MAX_ATTACHMENT_TEXT = 200_000;
const MAX_CREATED_TASKS = 200;

/* ------------------------------------------------------------------ uploads */

/**
 * Extensions we can turn into text ourselves, so their contents ride along in the
 * prompt rather than needing to be opened.
 */
const TEXT_EXTENSIONS = new Set([
  ".csv", ".tsv", ".txt", ".md", ".markdown", ".json", ".yaml", ".yml",
  ".log", ".xml", ".html", ".htm", ".ics", ".eml", ".rtf",
]);

/** Extensions the Read tool can genuinely make sense of on disk. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/**
 * Formats that would be *stored* fine and then turn out to be unreadable — a .docx
 * is a zip, and a run that opens one gets binary noise. Refused at upload naming
 * what to do instead, because a silently unusable attachment costs the user a whole
 * round trip to discover.
 */
const UNREADABLE: Record<string, string> = {
  ".docx": "a Word file is a zip archive, so nothing here can read it",
  ".doc": "an old Word file is a binary format nothing here can read",
  ".xlsx": "an Excel file is a zip archive, so nothing here can read it",
  ".xls": "an old Excel file is a binary format nothing here can read",
  ".pptx": "a PowerPoint file is a zip archive, so nothing here can read it",
  ".zip": "an archive would have to be unpacked, which nothing here does",
  ".numbers": "a Numbers file is a bundle nothing here can read",
  ".pages": "a Pages file is a bundle nothing here can read",
};

export interface IntakeUpload {
  filename: string;
  /** Browser-reported type. Advisory only — the extension decides. */
  mime?: string;
  /** File contents, base64. */
  data: string;
}

/**
 * Decides how a file will reach the model, or refuses it with the reason and the
 * way round it. The extension decides rather than the browser's `mime`, because a
 * CSV arrives as anything from `text/csv` to `application/vnd.ms-excel` to `""`
 * depending on the operating system that produced it.
 */
export function classifyAttachment(filename: string, mime?: string): IntakeAttachmentKind {
  const ext = extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";

  const known = UNREADABLE[ext];
  if (known) {
    throw badRequest(
      `${filename} cannot be used: ${known}. Export it to CSV or PDF, or paste the text straight into the box.`,
      { filename, extension: ext },
    );
  }
  // No extension but the browser is confident: trust it rather than refusing a
  // screenshot pasted straight off the clipboard, which often arrives unnamed.
  if (mime?.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime?.startsWith("text/") || mime === "application/json") return "text";

  throw badRequest(
    `${filename} is not a kind of file this can read. Text, CSV, Markdown, JSON, images and PDFs work; paste anything else as text.`,
    { filename, extension: ext, mime },
  );
}

/* ------------------------------------------------------------- board context */

interface IntakeBoard {
  id: string;
  name: string;
  archived: boolean;
}

/** The board fields intake needs, read directly to keep this module a leaf. */
function intakeBoard(boardId: string): IntakeBoard {
  const row = getDb()
    .query<{ id: string; name: string; archived: number }, [string]>(
      "SELECT id, name, archived FROM boards WHERE id = ?",
    )
    .get(boardId);
  if (!row) throw notFound("board", boardId);
  return { id: row.id, name: row.name, archived: row.archived === 1 };
}

/** Absolute location of an attachment. Rows store it relative to `INTAKE_DIR`. */
export const attachmentPath = (attachment: Pick<IntakeAttachment, "path">): string =>
  resolve(INTAKE_DIR, attachment.path);

/* ---------------------------------------------------------------------- reads */

function attachmentsFor(messageIds: string[]): Map<string, IntakeAttachment[]> {
  const byMessage = new Map<string, IntakeAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = getDb()
    .query<IntakeAttachmentRow, SQLQueryBindings[]>(
      `SELECT * FROM intake_attachments
        WHERE message_id IN (${messageIds.map(() => "?").join(", ")})
        ORDER BY datetime(created_at) ASC, rowid ASC`,
    )
    .all(...messageIds);
  for (const row of rows) {
    const attachment = toIntakeAttachment(row);
    const list = byMessage.get(attachment.messageId) ?? [];
    list.push(attachment);
    byMessage.set(attachment.messageId, list);
  }
  return byMessage;
}

export interface ListIntakeFilter {
  boardId?: string;
  /** Defaults to every status, because this is a transcript before it is a queue. */
  status?: IntakeStatus | readonly IntakeStatus[];
  /** Oldest first, which is chat order and also queue order. */
  oldestFirst?: boolean;
  includeArchivedBoards?: boolean;
  limit?: number;
}

/**
 * The conversation, or the queue, depending on the filter. Attachments are joined
 * in one extra query rather than one per message — a chat of thirty messages would
 * otherwise cost thirty-one reads to render.
 */
export function listIntakeMessages(filter: ListIntakeFilter = {}): IntakeMessageWithFiles[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.boardId) {
    where.push("m.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status as IntakeStatus];
    if (statuses.length === 0) throw badRequest("status filter cannot be empty");
    where.push(`m.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (!filter.includeArchivedBoards) where.push("b.archived = 0");

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  // By time, not by id: ids are random strings, so ordering by them would put the
  // conversation in an arbitrary order and make "the oldest queued" meaningless.
  const direction = filter.oldestFirst === false ? "DESC" : "ASC";
  const rows = getDb()
    .query<IntakeMessageRow, SQLQueryBindings[]>(
      `SELECT m.* FROM intake_messages m
         JOIN boards b ON b.id = m.board_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY datetime(m.created_at) ${direction}, m.rowid ${direction} LIMIT ?`,
    )
    .all(...params, limit);

  const files = attachmentsFor(rows.map((row) => row.id));
  return rows.map((row) => ({ ...toIntakeMessage(row), attachments: files.get(row.id) ?? [] }));
}

function messageRow(messageId: string): IntakeMessage {
  const row = getDb().query<IntakeMessageRow, [string]>("SELECT * FROM intake_messages WHERE id = ?").get(messageId);
  if (!row) throw notFound("intake message", messageId);
  return toIntakeMessage(row);
}

export function getIntakeMessage(messageId: string): IntakeMessageWithContext {
  const row = getDb()
    .query<
      IntakeMessageRow & {
        board_name: string;
        board_starts_at: string;
        board_ends_at: string;
        board_duration_kind: string;
        board_description: string | null;
        requested_by_name: string;
      },
      [string]
    >(
      `SELECT m.*,
              b.name          AS board_name,
              b.starts_at     AS board_starts_at,
              b.ends_at       AS board_ends_at,
              b.duration_kind AS board_duration_kind,
              b.description   AS board_description,
              u.display_name  AS requested_by_name
         FROM intake_messages m
         JOIN boards b ON b.id = m.board_id
         JOIN users u  ON u.id = m.requested_by
        WHERE m.id = ?`,
    )
    .get(messageId);
  if (!row) throw notFound("intake message", messageId);

  const attachments = attachmentsFor([messageId]).get(messageId) ?? [];
  return {
    ...toIntakeMessage(row),
    attachments,
    boardName: row.board_name,
    boardStartsAt: row.board_starts_at,
    boardEndsAt: row.board_ends_at,
    boardDurationKind: row.board_duration_kind as DurationKind,
    boardDescription: row.board_description,
    requestedByName: row.requested_by_name,
    // Only the kinds that cannot be inlined. An empty list here is what tells a
    // watcher it can withhold file access from the run entirely.
    readablePaths: attachments
      .filter((attachment) => attachment.kind !== "text")
      .map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        kind: attachment.kind,
        absolutePath: attachmentPath(attachment),
      })),
  };
}

export function getIntakeAttachment(attachmentId: string): IntakeAttachment {
  const row = getDb()
    .query<IntakeAttachmentRow, [string]>("SELECT * FROM intake_attachments WHERE id = ?")
    .get(attachmentId);
  if (!row) throw notFound("attachment", attachmentId);
  return toIntakeAttachment(row);
}

/** Counts for the header's control — one read, no message bodies. */
export function getIntakeSummary(boardId: string): BoardIntakeSummary {
  const row = getDb()
    .query<{ total: number; open: number; working: number; last_at: string | null }, [string]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS working,
              MAX(created_at) AS last_at
         FROM intake_messages WHERE board_id = ?`,
    )
    .get(boardId);
  return {
    open: row?.open ?? 0,
    working: (row?.working ?? 0) > 0,
    total: row?.total ?? 0,
    lastMessageAt: row?.last_at ?? null,
  };
}

/* --------------------------------------------------------------------- writes */

export interface PostIntakeInput {
  /** What the user typed. Optional when they pasted something self-explanatory. */
  instruction?: string;
  /** Pasted text, kept verbatim. */
  content?: string | null;
  attachments?: IntakeUpload[];
}

export interface PostIntakeResult {
  message: IntakeMessageWithContext;
  /** Files refused at upload, with the reason, so the UI can say which and why. */
  rejected: Array<{ filename: string; reason: string }>;
}

/**
 * Posts one message into a board's intake chat and queues it.
 *
 * Files are written to disk and decoded here rather than at read time, so by the
 * time a run sees this message the question "can this be read at all" has already
 * been answered. A file we cannot make sense of is refused now, with the reason,
 * instead of becoming an agent run that reports failure five minutes later.
 *
 * Nothing is created on the board by this call. It returns a queued message.
 */
export function postIntakeMessage(
  boardId: string,
  input: PostIntakeInput,
  actor: ActorContext,
): PostIntakeResult {
  const board = intakeBoard(boardId);
  if (board.archived) throw conflict("cannot add to an archived board", { boardId });

  const instruction = (input.instruction ?? "").trim();
  if (instruction.length > MAX_INSTRUCTION) {
    throw badRequest(`instruction must be ${MAX_INSTRUCTION} characters or fewer`);
  }
  const content = input.content?.trim() ? input.content : null;
  if (content && content.length > MAX_CONTENT) {
    throw badRequest(
      `pasted content must be ${MAX_CONTENT} characters or fewer — attach it as a .csv or .txt file instead`,
      { length: content.length },
    );
  }

  const uploads = input.attachments ?? [];
  if (uploads.length > MAX_ATTACHMENTS) {
    throw badRequest(`at most ${MAX_ATTACHMENTS} files per message`, { received: uploads.length });
  }
  // A message with nothing in it is not a message. Said here rather than letting an
  // agent run discover it, because the run would have nothing to report.
  if (!instruction && !content && uploads.length === 0) {
    throw badRequest("paste something, attach a file, or say what you want done");
  }

  const messageId = newId("itk");
  const now = new Date().toISOString();
  const rejected: Array<{ filename: string; reason: string }> = [];

  /** Decoded and written files, ready to insert. Built before the transaction. */
  const staged: Array<{
    id: string;
    filename: string;
    mime: string;
    kind: IntakeAttachmentKind;
    bytes: number;
    relativePath: string;
    text: string | null;
  }> = [];
  const writtenPaths: string[] = [];

  try {
    for (const upload of uploads) {
      const filename = (upload.filename ?? "").trim() || "pasted";
      let kind: IntakeAttachmentKind;
      try {
        kind = classifyAttachment(filename, upload.mime);
      } catch (error) {
        // One bad file must not lose the other five and the typed instruction.
        rejected.push({ filename, reason: error instanceof Error ? error.message : "unsupported file" });
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(upload.data ?? "", "base64"));
      } catch {
        rejected.push({ filename, reason: `${filename} did not arrive as valid base64` });
        continue;
      }
      if (bytes.byteLength === 0) {
        rejected.push({ filename, reason: `${filename} is empty` });
        continue;
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        rejected.push({
          filename,
          reason: `${filename} is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; the limit is ${
            MAX_ATTACHMENT_BYTES / 1024 / 1024
          }MB`,
        });
        continue;
      }

      const id = newId("att");
      const extension = extname(filename).toLowerCase() || (kind === "pdf" ? ".pdf" : kind === "image" ? ".png" : ".txt");
      const relativePath = join(boardId, `${id}${extension}`);
      const absolutePath = resolve(INTAKE_DIR, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, bytes);
      writtenPaths.push(absolutePath);

      // Decoded now, once. This is what lets the prompt carry a CSV inline and the
      // run be given no file access when nothing else is attached.
      let text: string | null = null;
      if (kind === "text") {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        text = decoded.length > MAX_ATTACHMENT_TEXT ? `${decoded.slice(0, MAX_ATTACHMENT_TEXT)}\n… truncated` : decoded;
      }

      staged.push({
        id,
        filename,
        mime: upload.mime?.trim() || (kind === "pdf" ? "application/pdf" : kind === "image" ? "image/png" : "text/plain"),
        kind,
        bytes: bytes.byteLength,
        relativePath,
        text,
      });
    }

    if (!instruction && !content && staged.length === 0) {
      throw badRequest(
        rejected.length > 0
          ? `nothing usable was attached: ${rejected.map((entry) => entry.reason).join("; ")}`
          : "paste something, attach a file, or say what you want done",
        { rejected },
      );
    }

    write((db) => {
      db.run(
        `INSERT INTO intake_messages (id, board_id, instruction, content, status, requested_by, actor_source, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [messageId, boardId, instruction, content, actor.actorId, actor.source, now],
      );
      for (const file of staged) {
        db.run(
          `INSERT INTO intake_attachments (id, message_id, board_id, filename, mime, kind, bytes, path, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [file.id, messageId, boardId, file.filename, file.mime, file.kind, file.bytes, file.relativePath, file.text, now],
        );
      }
      record(db, actor, "intake.posted", { boardId }, {
        messageId,
        chars: (content?.length ?? 0) + instruction.length,
        attachments: staged.map((file) => `${file.filename} (${file.kind})`),
        rejected: rejected.map((entry) => entry.filename),
      });
    });
  } catch (error) {
    // The files are written before the row exists, so a failed insert would leave
    // orphans on disk with nothing pointing at them.
    for (const path of writtenPaths) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort; a stray file is not worth masking the real error.
      }
    }
    throw error;
  }

  log.info("intake message posted", {
    messageId,
    boardId,
    attachments: staged.length,
    readable: staged.filter((file) => file.kind !== "text").length,
    rejected: rejected.length,
    contentChars: content?.length ?? 0,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { message: getIntakeMessage(messageId), rejected };
}

/**
 * Takes a queued message. Read and write share one transaction, which is the lock:
 * two runners racing for the same paste cannot both win and create the cards twice.
 */
export function claimIntakeMessage(messageId: string, actor: ActorContext): IntakeMessageWithContext {
  const before = messageRow(messageId);
  write((db) => {
    const current = db
      .query<{ status: string }, [string]>("SELECT status FROM intake_messages WHERE id = ?")
      .get(messageId);
    if (!current) throw notFound("intake message", messageId);
    if (current.status !== "pending") {
      throw conflict(`intake message ${messageId} is ${current.status}, not pending`, {
        messageId,
        status: current.status,
      });
    }
    db.run("UPDATE intake_messages SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ?", [
      new Date().toISOString(),
      messageId,
    ]);
    record(db, actor, "intake.claimed", { boardId: before.boardId }, { messageId });
  });

  log.info("intake message claimed", {
    messageId,
    boardId: before.boardId,
    actor: actor.actorId,
    source: actor.source,
  });
  return getIntakeMessage(messageId);
}

export interface CompleteIntakeInput {
  status?: Extract<IntakeStatus, "done" | "failed">;
  /** The reply the user reads in the chat: what you made, and what you left out. */
  note: string;
  /** Ids of the cards created, so the reply can link them. */
  createdTasks?: string[];
}

/**
 * Closes out a message. The cards were created through `task_create` like any
 * other, so this records the reply rather than doing the work — but it does verify
 * the ids, because a reply claiming cards that do not exist is worse than no reply.
 */
export function completeIntakeMessage(
  messageId: string,
  input: CompleteIntakeInput,
  actor: ActorContext,
): IntakeMessageWithContext {
  const message = messageRow(messageId);
  if (!OPEN_INTAKE_STATUSES.includes(message.status)) {
    throw conflict(`intake message ${messageId} is already ${message.status}`, {
      messageId,
      status: message.status,
      note: message.note,
    });
  }
  const status = input.status ?? "done";
  if (status !== "done" && status !== "failed") throw badRequest("status must be done or failed", { received: status });

  const note = input.note?.trim();
  if (!note) throw badRequest("note is required — say what you made from this, and what you left out");
  if (note.length > MAX_NOTE) throw badRequest(`note must be ${MAX_NOTE} characters or fewer`);

  const ids = [...new Set((input.createdTasks ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length > MAX_CREATED_TASKS) throw badRequest(`at most ${MAX_CREATED_TASKS} task ids`);
  if (ids.length > 0) {
    const found = getDb()
      .query<{ id: string }, SQLQueryBindings[]>(
        `SELECT id FROM tasks WHERE board_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(message.boardId, ...ids)
      .map((row) => row.id);
    const missing = ids.filter((id) => !found.includes(id));
    // Checked because the chat renders these as links. A reply pointing at cards
    // that are not on the board reads as the work having been done when it was not.
    if (missing.length > 0) {
      throw badRequest(
        `these task ids are not on this board: ${missing.join(", ")} — pass only ids task_create returned for ${message.boardId}`,
        { missing, boardId: message.boardId },
      );
    }
  }

  const finishedAt = new Date().toISOString();
  write((db) => {
    db.run(
      "UPDATE intake_messages SET status = ?, note = ?, created_tasks = ?, finished_at = ? WHERE id = ?",
      [status, note, ids.length > 0 ? JSON.stringify(ids) : null, finishedAt, messageId],
    );
    record(db, actor, "intake.completed", { boardId: message.boardId }, {
      messageId,
      status,
      created: ids.length,
      note,
    });
  });

  log[status === "done" ? "info" : "warn"]("intake message completed", {
    messageId,
    boardId: message.boardId,
    status,
    created: ids.length,
    actor: actor.actorId,
    source: actor.source,
  });
  return getIntakeMessage(messageId);
}

/**
 * Puts a claimed message back in the queue. The watcher calls this when a run dies
 * without finishing, so a crash costs a retry rather than the paste.
 */
export function releaseIntakeMessage(
  messageId: string,
  reason: string,
  actor: ActorContext,
): IntakeMessageWithContext {
  const message = messageRow(messageId);
  if (message.status !== "claimed") {
    throw conflict(`intake message ${messageId} is ${message.status}, not claimed`, {
      messageId,
      status: message.status,
    });
  }
  write((db) => {
    db.run("UPDATE intake_messages SET status = 'pending', claimed_at = NULL WHERE id = ?", [messageId]);
    record(db, actor, "intake.released", { boardId: message.boardId }, { messageId, reason });
  });
  log.warn("intake message released back to pending", { messageId, reason });
  return getIntakeMessage(messageId);
}

/**
 * Drops a queued or claimed message. The composer is disabled while one is in
 * flight, so a message left behind by a dead process would otherwise wedge the chat.
 */
export function cancelIntakeMessage(
  messageId: string,
  reason: string,
  actor: ActorContext,
): IntakeMessageWithContext {
  const message = messageRow(messageId);
  if (!OPEN_INTAKE_STATUSES.includes(message.status)) {
    throw conflict(`intake message ${messageId} is already ${message.status}`, {
      messageId,
      status: message.status,
    });
  }
  write((db) => {
    db.run("UPDATE intake_messages SET status = 'cancelled', note = ?, finished_at = ? WHERE id = ?", [
      reason.trim() || "cancelled",
      new Date().toISOString(),
      messageId,
    ]);
    record(db, actor, "intake.cancelled", { boardId: message.boardId }, { messageId, reason });
  });
  log.warn("intake message cancelled", { messageId, reason, actor: actor.actorId });
  return getIntakeMessage(messageId);
}

/**
 * Removes a message and its files from disk. The row cascades its attachments, but
 * the bytes are ours to clean up — nothing else knows they are there.
 */
export function deleteIntakeMessage(messageId: string, actor: ActorContext): { id: string } {
  const message = messageRow(messageId);
  const attachments = attachmentsFor([messageId]).get(messageId) ?? [];
  write((db: Database) => {
    record(db, actor, "intake.deleted", { boardId: message.boardId }, {
      messageId,
      attachments: attachments.length,
    });
    db.run("DELETE FROM intake_messages WHERE id = ?", [messageId]);
  });
  for (const attachment of attachments) {
    try {
      rmSync(attachmentPath(attachment), { force: true });
    } catch {
      // The row is gone either way; a leftover file is not worth failing the call.
    }
  }
  log.warn("intake message deleted", { messageId, attachments: attachments.length, actor: actor.actorId });
  return { id: messageId };
}

/** Byte size on disk, for the UI. Missing means the file was cleaned up under us. */
export function attachmentExists(attachment: IntakeAttachment): boolean {
  try {
    return statSync(attachmentPath(attachment)).isFile();
  } catch {
    return false;
  }
}
