import type { SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getDb, write } from "../db/index.ts";
import {
  toWhatsAppChat,
  toWhatsAppImport,
  toWhatsAppMedia,
  toWhatsAppMessage,
  type WhatsAppChatRow,
  type WhatsAppImportRow,
  type WhatsAppMediaRow,
  type WhatsAppMessageRow,
} from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId, slugify } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { WHATSAPP_DIR } from "../lib/paths.ts";
import {
  chatNameFrom,
  isReadablePhoto,
  parseWhatsAppChat,
  type DateOrder,
  type ParsedWhatsAppMessage,
} from "../lib/whatsapp.ts";
import { extractZipEntry, readZipEntries, type ZipEntry } from "../lib/zip.ts";
import {
  OPEN_WHATSAPP_IMPORT_STATUSES,
  type BoardWhatsAppSummary,
  type WhatsAppChat,
  type WhatsAppImportStatus,
  type WhatsAppImportWithChat,
  type WhatsAppImportWithContext,
  type TaskPhoto,
  type WhatsAppMedia,
} from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

const log = createLogger("whatsapp");

/**
 * Turning an exported WhatsApp chat into cards, incrementally.
 *
 * WhatsApp has no API a board can read, so the source is the phone's own
 * "Export chat" — a zip holding the transcript and, with "Attach media", the
 * files it mentions. An export is the whole history every time. What makes it a
 * *sync* rather than a one-off paste is the watermark on `whatsapp_chats`: one
 * per (board, chat), so a re-upload of the same chat reads only what is new to
 * this board.
 *
 * The rules are the sync rules, deliberately:
 *   - The window is decided at upload and frozen on the import, and the
 *     watermark moves to its end only when the run completes `done`. A failed or
 *     cancelled import leaves it where it was, so the next upload re-reads the
 *     same messages instead of stepping over them.
 *   - A first import is capped to recent history (`WHATSAPP_FIRST_IMPORT_DAYS`),
 *     and what it left out is recorded in `capped_from` — a six-year group chat
 *     is not six years of open work, but the gap is stated, not hidden.
 *   - One import per chat may be open at a time. Two runs over one window would
 *     make the cards twice.
 *
 * Messages and their files are joined at upload: each message row points at the
 * media row for the file it mentions. Every mentioned file is *recorded*, so a
 * run still knows "sent a video here", but only photos are written to disk, and
 * a run is allowed to open them only when the upload asked for it — reading the
 * pictures is opt-in per upload, never the default.
 *
 * Like `intake.ts` this reads the board fields it needs with its own query:
 * `getBoardDetail` embeds this module's summary, so importing the board service
 * would close a cycle.
 */

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** How far back a chat's FIRST import reaches. Later imports start at the watermark. */
export const WHATSAPP_FIRST_IMPORT_DAYS = envNumber("WHATSAPP_FIRST_IMPORT_DAYS", 14);
/** Messages per import. Past this the prompt stops being readable; the rest waits. */
export const WHATSAPP_MAX_MESSAGES = envNumber("WHATSAPP_MAX_MESSAGES", 800);
/** Upload ceiling. The route reads the body with this same number. */
export const WHATSAPP_MAX_UPLOAD_BYTES = envNumber("WHATSAPP_MAX_UPLOAD_MB", 256) * 1024 * 1024;
/** Day/month order when the export itself never settles it. */
const FALLBACK_ORDER: DateOrder = process.env.WHATSAPP_DATE_ORDER === "mdy" ? "mdy" : "dmy";

const MAX_INSTRUCTION = 2_000;
const MAX_NOTE = 4_000;
const MAX_CREATED_TASKS = 200;
/** A single photo past this is kept as a reference only. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** The transcript is decoded into memory; a text file this big is not a chat. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/* ------------------------------------------------------------- board context */

interface WhatsAppBoard {
  id: string;
  name: string;
  archived: boolean;
}

function whatsappBoard(boardId: string): WhatsAppBoard {
  const row = getDb()
    .query<{ id: string; name: string; archived: number }, [string]>(
      "SELECT id, name, archived FROM boards WHERE id = ?",
    )
    .get(boardId);
  if (!row) throw notFound("board", boardId);
  return { id: row.id, name: row.name, archived: row.archived === 1 };
}

/** Absolute location of a stored photo. Rows keep it relative to `WHATSAPP_DIR`. */
export const whatsappMediaPath = (media: Pick<WhatsAppMedia, "path">): string | null =>
  media.path ? resolve(WHATSAPP_DIR, media.path) : null;

export function whatsappMediaExists(media: WhatsAppMedia): boolean {
  const path = whatsappMediaPath(media);
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- reads */

function chatRow(chatId: string): WhatsAppChatRow {
  const row = getDb().query<WhatsAppChatRow, [string]>("SELECT * FROM whatsapp_chats WHERE id = ?").get(chatId);
  if (!row) throw notFound("whatsapp chat", chatId);
  return row;
}

export function listWhatsAppChats(boardId: string): WhatsAppChat[] {
  return getDb()
    .query<WhatsAppChatRow, [string]>(
      "SELECT * FROM whatsapp_chats WHERE board_id = ? ORDER BY datetime(updated_at) DESC, rowid DESC",
    )
    .all(boardId)
    .map(toWhatsAppChat);
}

export interface ListWhatsAppImportsFilter {
  boardId?: string;
  chatId?: string;
  status?: WhatsAppImportStatus | readonly WhatsAppImportStatus[];
  oldestFirst?: boolean;
  includeArchivedBoards?: boolean;
  limit?: number;
}

type ImportWithChatRow = WhatsAppImportRow & { chat_name: string; chat_key: string };

const withChat = (row: ImportWithChatRow): WhatsAppImportWithChat => ({
  ...toWhatsAppImport(row),
  chatName: row.chat_name,
  chatKey: row.chat_key,
});

/** The transcript of uploads, or the queue, depending on the filter. */
export function listWhatsAppImports(filter: ListWhatsAppImportsFilter = {}): WhatsAppImportWithChat[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.boardId) {
    where.push("i.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.chatId) {
    where.push("i.chat_id = ?");
    params.push(filter.chatId);
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status as WhatsAppImportStatus];
    if (statuses.length === 0) throw badRequest("status filter cannot be empty");
    where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (!filter.includeArchivedBoards) where.push("b.archived = 0");

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const direction = filter.oldestFirst === false ? "DESC" : "ASC";
  return getDb()
    .query<ImportWithChatRow, SQLQueryBindings[]>(
      `SELECT i.*, c.name AS chat_name, c.chat_key AS chat_key
         FROM whatsapp_imports i
         JOIN whatsapp_chats c ON c.id = i.chat_id
         JOIN boards b ON b.id = i.board_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY datetime(i.created_at) ${direction}, i.rowid ${direction} LIMIT ?`,
    )
    .all(...params, limit)
    .map(withChat);
}

function importRow(importId: string): WhatsAppImportWithChat {
  const row = getDb()
    .query<ImportWithChatRow, [string]>(
      `SELECT i.*, c.name AS chat_name, c.chat_key AS chat_key
         FROM whatsapp_imports i JOIN whatsapp_chats c ON c.id = i.chat_id
        WHERE i.id = ?`,
    )
    .get(importId);
  if (!row) throw notFound("whatsapp import", importId);
  return withChat(row);
}

export function getWhatsAppImport(importId: string): WhatsAppImportWithContext {
  const base = importRow(importId);
  const db = getDb();
  const board = db
    .query<{ name: string; starts_at: string; ends_at: string; description: string | null }, [string]>(
      "SELECT name, starts_at, ends_at, description FROM boards WHERE id = ?",
    )
    .get(base.boardId);
  if (!board) throw notFound("board", base.boardId);
  const chat = chatRow(base.chatId);

  const media = db
    .query<WhatsAppMediaRow, [string]>("SELECT * FROM whatsapp_media WHERE import_id = ? ORDER BY rowid")
    .all(importId)
    .map(toWhatsAppMedia);
  const messages = db
    .query<WhatsAppMessageRow, [string]>("SELECT * FROM whatsapp_messages WHERE import_id = ? ORDER BY seq")
    .all(importId)
    .map(toWhatsAppMessage);

  return {
    ...base,
    selfName: chat.self_name,
    boardName: board.name,
    boardStartsAt: board.starts_at,
    boardEndsAt: board.ends_at,
    boardDescription: board.description,
    messages,
    media,
    // Only when the upload asked for the photos to be looked at. An empty list is
    // what tells the watcher the run gets no file access at all.
    readablePaths: base.readPhotos
      ? media
          .filter((entry) => entry.readable && entry.path)
          .map((entry) => ({ id: entry.id, filename: entry.filename, absolutePath: whatsappMediaPath(entry)! }))
      : [],
  };
}

export function getWhatsAppMedia(mediaId: string): WhatsAppMedia {
  const row = getDb().query<WhatsAppMediaRow, [string]>("SELECT * FROM whatsapp_media WHERE id = ?").get(mediaId);
  if (!row) throw notFound("whatsapp media", mediaId);
  return toWhatsAppMedia(row);
}

export function getWhatsAppSummary(boardId: string): BoardWhatsAppSummary {
  const db = getDb();
  const chats = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM whatsapp_chats WHERE board_id = ?")
    .get(boardId);
  const imports = db
    .query<{ open: number | null; working: number | null }, [string]>(
      `SELECT SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS working
         FROM whatsapp_imports WHERE board_id = ?`,
    )
    .get(boardId);
  return { chats: chats?.n ?? 0, open: imports?.open ?? 0, working: (imports?.working ?? 0) > 0 };
}

/* --------------------------------------------------------------------- upload */

export interface WhatsAppUploadInput {
  /** The uploaded file's name. For iOS it is the only place the chat's name lives. */
  filename: string;
  data: Uint8Array;
  instruction?: string;
  /** Let the run open the photos. Off unless asked for. */
  readPhotos?: boolean;
  /** An existing chat's id or key to continue, or a name for a new one. Auto-detected when absent. */
  chat?: string;
  /** How the user appears in this chat. Remembered on the chat once given. */
  selfName?: string;
  /** Read from this instant instead of the watermark — a deliberate re-read. */
  since?: string;
}

export interface WhatsAppUploadResult {
  import: WhatsAppImportWithChat;
  chat: WhatsAppChat;
  /** Facts about the parse the user should see: a guessed date order, a capped window. */
  notes: string[];
}

/** The transcript inside the export. iOS calls it `_chat.txt`; Android names it after the chat. */
function pickTranscript(entries: ZipEntry[]): ZipEntry {
  const texts = entries.filter((entry) => extname(entry.basename).toLowerCase() === ".txt");
  const chosen =
    texts.find((entry) => entry.basename === "_chat.txt") ??
    texts.find((entry) => /^WhatsApp Chat/i.test(entry.basename)) ??
    [...texts].sort((a, b) => b.size - a.size)[0];
  if (!chosen) {
    throw badRequest(
      "this zip has no chat transcript in it — use WhatsApp's own Export chat, which puts a .txt file inside",
      { files: entries.slice(0, 10).map((entry) => entry.name) },
    );
  }
  if (chosen.size > MAX_TRANSCRIPT_BYTES) {
    throw badRequest(`the transcript is ${Math.round(chosen.size / 1024 / 1024)}MB, which is not a chat export`);
  }
  return chosen;
}

const isZip = (data: Uint8Array) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;

/** The chat this upload continues: named explicitly, or recognised by its name. */
function resolveChat(
  boardId: string,
  requested: string | undefined,
  detectedName: string,
): { existing: WhatsAppChatRow | null; name: string; key: string } {
  const db = getDb();
  const wanted = requested?.trim();
  if (wanted) {
    const match = db
      .query<WhatsAppChatRow, [string, string, string]>(
        "SELECT * FROM whatsapp_chats WHERE board_id = ? AND (id = ? OR chat_key = ?)",
      )
      .get(boardId, wanted, slugify(wanted));
    if (match) return { existing: match, name: match.name, key: match.chat_key };
  }
  const name = (wanted || detectedName).slice(0, 120);
  const key = slugify(name);
  const existing =
    db
      .query<WhatsAppChatRow, [string, string]>("SELECT * FROM whatsapp_chats WHERE board_id = ? AND chat_key = ?")
      .get(boardId, key) ?? null;
  return { existing, name, key };
}

function parseKeys(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Parses an export, works out what this board has not read yet, and queues it.
 *
 * Nothing is created on the board by this call. What it guarantees is that by the
 * time a run sees the import, the window is fixed, the messages are parsed and
 * each one is joined to its file — so the run's whole job is judgement.
 */
export function uploadWhatsAppExport(
  boardId: string,
  input: WhatsAppUploadInput,
  actor: ActorContext,
): WhatsAppUploadResult {
  const board = whatsappBoard(boardId);
  if (board.archived) throw conflict("cannot import into an archived board", { boardId });

  const filename = basename((input.filename ?? "").trim() || "WhatsApp Chat.zip");
  const instruction = (input.instruction ?? "").trim();
  if (instruction.length > MAX_INSTRUCTION) {
    throw badRequest(`instruction must be ${MAX_INSTRUCTION} characters or fewer`);
  }
  const data = input.data;
  if (!data || data.byteLength === 0) throw badRequest("the upload was empty");
  if (data.byteLength > WHATSAPP_MAX_UPLOAD_BYTES) {
    throw badRequest(
      `the export is ${Math.round(data.byteLength / 1024 / 1024)}MB; the limit is ${WHATSAPP_MAX_UPLOAD_BYTES / 1024 / 1024}MB — export "Without media" if you do not need the photos`,
    );
  }

  let since: string | null = null;
  if (input.since) {
    const parsed = new Date(input.since);
    if (Number.isNaN(parsed.getTime())) throw badRequest("since must be a date", { since: input.since });
    since = parsed.toISOString();
  }

  // A zip from "Attach media" or iOS; a bare .txt from Android's "Without media".
  let entries: ZipEntry[] = [];
  let transcriptName: string;
  let transcript: string;
  if (isZip(data)) {
    entries = readZipEntries(data);
    const entry = pickTranscript(entries);
    transcriptName = entry.basename;
    transcript = new TextDecoder("utf-8").decode(extractZipEntry(data, entry));
  } else if (extname(filename).toLowerCase() === ".txt") {
    transcriptName = filename;
    transcript = new TextDecoder("utf-8").decode(data);
  } else {
    throw badRequest("upload the .zip WhatsApp's Export chat produces (or its .txt, for an export without media)");
  }

  const byName = new Map(entries.map((entry) => [entry.basename, entry]));
  const parsed = parseWhatsAppChat(transcript, { archiveNames: new Set(byName.keys()), fallbackOrder: FALLBACK_ORDER });
  if (parsed.messages.length === 0) {
    throw badRequest(
      `no messages could be read from ${transcriptName} — it does not look like a WhatsApp export`,
      { unparsedLines: parsed.unparsedLines },
    );
  }

  const target = resolveChat(boardId, input.chat, chatNameFrom(filename, transcriptName));
  const chatId = target.existing?.id ?? newId("wac");
  if (target.existing) {
    const [open] = listWhatsAppImports({
      chatId,
      status: OPEN_WHATSAPP_IMPORT_STATUSES,
      includeArchivedBoards: true,
      limit: 1,
    });
    if (open) {
      throw conflict(`"${target.name}" already has an import in progress — let it finish or cancel it first`, {
        importId: open.id,
        status: open.status,
      });
    }
  }

  // --- the window -----------------------------------------------------------
  const notes: string[] = [];
  const watermark = since ? null : target.existing?.synced_through ?? null;
  const boundary = since ? new Set<string>() : parseKeys(target.existing?.boundary_keys ?? null);

  let fresh: ParsedWhatsAppMessage[];
  let cappedFrom: string | null = null;
  let skippedOld = 0;
  if (watermark) {
    fresh = parsed.messages.filter(
      (message) => message.sentAt > watermark || (message.sentAt === watermark && !boundary.has(message.fingerprint)),
    );
  } else {
    const floor = since ?? new Date(Date.now() - WHATSAPP_FIRST_IMPORT_DAYS * 86_400_000).toISOString();
    fresh = parsed.messages.filter((message) => message.sentAt >= floor);
    skippedOld = parsed.messages.length - fresh.length;
    if (skippedOld > 0) {
      cappedFrom = parsed.messages[0]!.sentAt;
      notes.push(
        since
          ? `Read from ${since.slice(0, 10)} as asked; ${skippedOld} older message(s) were left out.`
          : `First import of this chat, so only the last ${WHATSAPP_FIRST_IMPORT_DAYS} days were read; ${skippedOld} older message(s) were left out. Pick a start date to reach further back.`,
      );
    }
  }
  if (fresh.length === 0) {
    throw badRequest(
      watermark
        ? `nothing new in this export — this board has already read "${target.name}" up to ${watermark}`
        : `no messages in this export fall inside the window (the newest is ${parsed.messages.at(-1)!.sentAt})`,
      { chat: target.name, syncedThrough: watermark, newest: parsed.messages.at(-1)!.sentAt },
    );
  }

  const batch = fresh.slice(0, WHATSAPP_MAX_MESSAGES);
  const remaining = fresh.length - batch.length;
  if (remaining > 0) {
    notes.push(
      `${fresh.length} new messages is more than one import reads, so this one covers the oldest ${batch.length}. Upload the same export again once it finishes to continue.`,
    );
  }
  if (parsed.dateOrderGuessed) {
    notes.push(
      `The export never shows a day after the 12th, so dates were read as ${FALLBACK_ORDER === "dmy" ? "day/month" : "month/day"}. Set WHATSAPP_DATE_ORDER if that is wrong.`,
    );
  }
  const through = batch.at(-1)!.sentAt;
  const throughKeys = batch.filter((message) => message.sentAt === through).map((message) => message.fingerprint);

  // --- media ----------------------------------------------------------------
  const importId = newId("wai");
  const now = new Date().toISOString();
  const mediaByMessage = new Map<number, string>();
  const media: Array<{ id: string; filename: string; kind: string; bytes: number; path: string | null; readable: boolean }> = [];
  const writtenPaths: string[] = [];

  try {
    for (const message of batch) {
      if (message.mediaState !== "attached" || !message.mediaName) continue;
      const entry = byName.get(message.mediaName);
      if (!entry) continue;
      const id = newId("wam");
      let path: string | null = null;
      // Photos only. Everything else stays a reference: nothing here will ever be
      // asked to watch a video, and keeping it would be disk spent on nothing.
      if (message.mediaKind === "photo" && entry.size <= MAX_PHOTO_BYTES) {
        const relative = join(boardId, importId, `${id}${extname(entry.basename).toLowerCase()}`);
        const absolute = resolve(WHATSAPP_DIR, relative);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, extractZipEntry(data, entry));
        writtenPaths.push(absolute);
        path = relative;
      }
      media.push({
        id,
        filename: entry.basename,
        kind: message.mediaKind ?? "other",
        bytes: entry.size,
        path,
        readable: path !== null && isReadablePhoto(entry.basename),
      });
      mediaByMessage.set(message.seq, id);
    }

    const selfName = input.selfName?.trim().slice(0, 80) || null;
    write((db) => {
      if (target.existing) {
        db.run("UPDATE whatsapp_chats SET self_name = COALESCE(?, self_name), updated_at = ? WHERE id = ?", [
          selfName,
          now,
          chatId,
        ]);
      } else {
        db.run(
          `INSERT INTO whatsapp_chats (id, board_id, chat_key, name, self_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [chatId, boardId, target.key, target.name, selfName, now, now],
        );
      }
      db.run(
        `INSERT INTO whatsapp_imports (id, board_id, chat_id, filename, instruction, read_photos, status, since,
                                       window_start, through, through_keys, capped_from, skipped_old, message_count,
                                       media_count, remaining, requested_by, actor_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          importId, boardId, chatId, filename, instruction, input.readPhotos ? 1 : 0, watermark,
          batch[0]!.sentAt, through, JSON.stringify(throughKeys), cappedFrom, skippedOld, batch.length,
          media.length, remaining, actor.actorId, actor.source, now,
        ],
      );
      const insertMedia = db.prepare(
        `INSERT INTO whatsapp_media (id, import_id, board_id, filename, kind, bytes, path, readable, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of media) {
        insertMedia.run(entry.id, importId, boardId, entry.filename, entry.kind, entry.bytes, entry.path, entry.readable ? 1 : 0, now);
      }
      const insertMessage = db.prepare(
        `INSERT INTO whatsapp_messages (import_id, seq, sent_at, author, body, media_name, media_state, media_id, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      batch.forEach((message, seq) => {
        insertMessage.run(
          importId, seq, message.sentAt, message.author, message.body, message.mediaName, message.mediaState,
          mediaByMessage.get(message.seq) ?? null, message.fingerprint,
        );
      });
      record(db, actor, "whatsapp.uploaded", { boardId }, {
        importId,
        chat: target.name,
        messages: batch.length,
        media: media.length,
        remaining,
        readPhotos: Boolean(input.readPhotos),
      });
    });
  } catch (error) {
    // Photos are written before the rows exist; a failed insert would orphan them.
    for (const path of writtenPaths) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort; a stray file is not worth masking the real error.
      }
    }
    throw error;
  }

  log.info("whatsapp export queued", {
    importId,
    boardId,
    chat: target.key,
    messages: batch.length,
    media: media.length,
    stored: writtenPaths.length,
    remaining,
    skippedOld,
    dateOrder: parsed.dateOrder,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { import: importRow(importId), chat: toWhatsAppChat(chatRow(chatId)), notes };
}

/* ------------------------------------------------------------------ lifecycle */

/** Read and write share one transaction, so two runs cannot both win one import. */
export function claimWhatsAppImport(importId: string, actor: ActorContext): WhatsAppImportWithContext {
  const before = importRow(importId);
  write((db) => {
    const current = db
      .query<{ status: string }, [string]>("SELECT status FROM whatsapp_imports WHERE id = ?")
      .get(importId);
    if (!current) throw notFound("whatsapp import", importId);
    if (current.status !== "pending") {
      throw conflict(`whatsapp import ${importId} is ${current.status}, not pending`, { importId, status: current.status });
    }
    db.run("UPDATE whatsapp_imports SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ?", [
      new Date().toISOString(),
      importId,
    ]);
    record(db, actor, "whatsapp.claimed", { boardId: before.boardId }, { importId });
  });
  log.info("whatsapp import claimed", { importId, boardId: before.boardId, actor: actor.actorId, source: actor.source });
  return getWhatsAppImport(importId);
}

export interface CompleteWhatsAppInput {
  status?: "done" | "failed";
  /** The reply the user reads: what was made, and what was left out. */
  note: string;
  createdTasks?: string[];
}

/**
 * Closes an import, and on `done` moves the chat's watermark to the end of its
 * window. That is the only place the watermark moves. A window re-read from an
 * earlier `since` never drags it backwards.
 */
export function completeWhatsAppImport(
  importId: string,
  input: CompleteWhatsAppInput,
  actor: ActorContext,
): WhatsAppImportWithContext {
  const current = importRow(importId);
  if (!OPEN_WHATSAPP_IMPORT_STATUSES.includes(current.status)) {
    throw conflict(`whatsapp import ${importId} is already ${current.status}`, { importId, status: current.status });
  }
  const status = input.status ?? "done";
  if (status !== "done" && status !== "failed") throw badRequest("status must be done or failed", { received: status });
  const note = input.note?.trim();
  if (!note) throw badRequest("note is required — say what you made from this chat, and what you left out");
  if (note.length > MAX_NOTE) throw badRequest(`note must be ${MAX_NOTE} characters or fewer`);

  const ids = [...new Set((input.createdTasks ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length > MAX_CREATED_TASKS) throw badRequest(`at most ${MAX_CREATED_TASKS} task ids`);
  if (ids.length > 0) {
    const found = new Set(
      getDb()
        .query<{ id: string }, SQLQueryBindings[]>(
          `SELECT id FROM tasks WHERE board_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
        )
        .all(current.boardId, ...ids)
        .map((row) => row.id),
    );
    const missing = ids.filter((id) => !found.has(id));
    // The panel renders these as links; a reply naming cards that are not there
    // reads as work done when it was not.
    if (missing.length > 0) {
      throw badRequest(
        `these task ids are not on this board: ${missing.join(", ")} — pass only ids task_create returned for ${current.boardId}`,
        { missing, boardId: current.boardId },
      );
    }
  }

  const importRecord = getDb()
    .query<{ through: string; through_keys: string }, [string]>(
      "SELECT through, through_keys FROM whatsapp_imports WHERE id = ?",
    )
    .get(importId)!;
  const chat = chatRow(current.chatId);
  const finishedAt = new Date().toISOString();

  let syncedThrough = chat.synced_through;
  let boundaryKeys = chat.boundary_keys;
  if (status === "done") {
    if (!syncedThrough || importRecord.through > syncedThrough) {
      syncedThrough = importRecord.through;
      boundaryKeys = importRecord.through_keys;
    } else if (importRecord.through === syncedThrough) {
      const merged = parseKeys(chat.boundary_keys);
      for (const key of parseKeys(importRecord.through_keys)) merged.add(key);
      boundaryKeys = JSON.stringify([...merged]);
    }
  }

  write((db) => {
    db.run("UPDATE whatsapp_imports SET status = ?, note = ?, created_tasks = ?, finished_at = ? WHERE id = ?", [
      status,
      note,
      ids.length > 0 ? JSON.stringify(ids) : null,
      finishedAt,
      importId,
    ]);
    db.run(
      `UPDATE whatsapp_chats
          SET synced_through = ?, boundary_keys = ?, last_import_at = ?, last_status = ?, last_detail = ?,
              imported = imported + ?, updated_at = ?
        WHERE id = ?`,
      [syncedThrough, boundaryKeys, finishedAt, status === "done" ? "ok" : "failed", note, ids.length, finishedAt, chat.id],
    );
    record(db, actor, "whatsapp.completed", { boardId: current.boardId }, {
      importId,
      chat: chat.name,
      status,
      created: ids.length,
      syncedThrough,
    });
  });

  log[status === "done" ? "info" : "warn"]("whatsapp import completed", {
    importId,
    boardId: current.boardId,
    status,
    created: ids.length,
    syncedThrough,
    actor: actor.actorId,
    source: actor.source,
  });
  return getWhatsAppImport(importId);
}

/** Back in the queue after a run died, so a crash costs a retry rather than the upload. */
export function releaseWhatsAppImport(importId: string, reason: string, actor: ActorContext): WhatsAppImportWithContext {
  const current = importRow(importId);
  if (current.status !== "claimed") {
    throw conflict(`whatsapp import ${importId} is ${current.status}, not claimed`, { importId, status: current.status });
  }
  write((db) => {
    db.run("UPDATE whatsapp_imports SET status = 'pending', claimed_at = NULL WHERE id = ?", [importId]);
    record(db, actor, "whatsapp.released", { boardId: current.boardId }, { importId, reason });
  });
  log.warn("whatsapp import released back to pending", { importId, reason });
  return getWhatsAppImport(importId);
}

/** Drops an open import. The watermark stays put, so the same window can be uploaded again. */
export function cancelWhatsAppImport(importId: string, reason: string, actor: ActorContext): WhatsAppImportWithContext {
  const current = importRow(importId);
  if (!OPEN_WHATSAPP_IMPORT_STATUSES.includes(current.status)) {
    throw conflict(`whatsapp import ${importId} is already ${current.status}`, { importId, status: current.status });
  }
  write((db) => {
    db.run("UPDATE whatsapp_imports SET status = 'cancelled', note = ?, finished_at = ? WHERE id = ?", [
      reason.trim() || "cancelled",
      new Date().toISOString(),
      importId,
    ]);
    record(db, actor, "whatsapp.cancelled", { boardId: current.boardId }, { importId, reason });
  });
  log.warn("whatsapp import cancelled", { importId, reason, actor: actor.actorId });
  return getWhatsAppImport(importId);
}

function removeImportFiles(boardId: string, importIds: string[]): void {
  for (const importId of importIds) {
    try {
      rmSync(resolve(WHATSAPP_DIR, boardId, importId), { recursive: true, force: true });
    } catch {
      // The rows are gone either way; a leftover folder is not worth failing the call.
    }
  }
}

/** Removes one upload and its photos. The chat's watermark is not touched. */
export function deleteWhatsAppImport(importId: string, actor: ActorContext): { id: string } {
  const current = importRow(importId);
  write((db) => {
    record(db, actor, "whatsapp.import_deleted", { boardId: current.boardId }, { importId, chat: current.chatName });
    db.run("DELETE FROM whatsapp_imports WHERE id = ?", [importId]);
  });
  removeImportFiles(current.boardId, [importId]);
  log.warn("whatsapp import deleted", { importId, actor: actor.actorId });
  return { id: importId };
}

/**
 * Forgets a chat on this board: its watermark, every import and every photo. The
 * next upload of it is a first import again. Cards already made stay on the
 * board, and their `sourceRef` still stops the same message becoming a second card.
 */
export function deleteWhatsAppChat(chatId: string, actor: ActorContext): { id: string } {
  const chat = chatRow(chatId);
  const importIds = getDb()
    .query<{ id: string }, [string]>("SELECT id FROM whatsapp_imports WHERE chat_id = ?")
    .all(chatId)
    .map((row) => row.id);
  write((db) => {
    record(db, actor, "whatsapp.chat_deleted", { boardId: chat.board_id }, { chatId, name: chat.name, imports: importIds.length });
    db.run("DELETE FROM whatsapp_chats WHERE id = ?", [chatId]);
  });
  removeImportFiles(chat.board_id, importIds);
  log.warn("whatsapp chat forgotten", { chatId, imports: importIds.length, actor: actor.actorId });
  return { id: chatId };
}

/* ---------------------------------------------------------------- card photos */

const MAX_LINKED_PHOTOS = 30;

type PhotoRow = WhatsAppMediaRow & {
  sent_at: string | null;
  author: string | null;
  body: string | null;
  position?: number;
};

function toTaskPhoto(row: PhotoRow, via: TaskPhoto["via"]): TaskPhoto {
  return {
    mediaId: row.id,
    filename: row.filename,
    bytes: row.bytes,
    sentAt: row.sent_at,
    author: row.author,
    caption: row.body?.trim() || null,
    via,
  };
}

/** A photo row the UI can actually show: kept, and still on disk. */
const showable = (row: PhotoRow) => row.kind === "photo" && whatsappMediaExists(toWhatsAppMedia(row));

/**
 * The photos a card shows, oldest first.
 *
 * Two sources, merged: the photo on the card's own source message, which every
 * card made from a chat has without anyone saying so, and whatever was linked on
 * purpose through `linkTaskPhotos` — the "same here" screenshot that followed it,
 * or the three photos of one defect. The first makes older cards (made before
 * linking existed) show something; the second is what makes a card complete.
 */
export function listTaskPhotos(taskId: string): TaskPhoto[] {
  const db = getDb();
  const task = db
    .query<{ board_id: string; source_ref: string | null }, [string]>("SELECT board_id, source_ref FROM tasks WHERE id = ?")
    .get(taskId);
  if (!task) throw notFound("task", taskId);

  const photos = new Map<string, TaskPhoto>();
  const order = new Map<string, number>();

  const source = /^whatsapp:([^:]+):([0-9a-f]+)$/.exec(task.source_ref ?? "");
  if (source) {
    // A re-read with an explicit start date can hold the same message twice; the
    // newest import whose file is still there wins.
    const rows = db
      .query<PhotoRow, [string, string, string]>(
        `SELECT m.*, msg.sent_at, msg.author, msg.body
           FROM whatsapp_messages msg
           JOIN whatsapp_imports i ON i.id = msg.import_id
           JOIN whatsapp_chats c   ON c.id = i.chat_id
           JOIN whatsapp_media m   ON m.id = msg.media_id
          WHERE i.board_id = ? AND c.chat_key = ? AND msg.fingerprint = ?
          ORDER BY datetime(i.created_at) DESC, i.rowid DESC`,
      )
      .all(task.board_id, source[1]!, source[2]!);
    const row = rows.find(showable);
    if (row) {
      photos.set(row.filename, toTaskPhoto(row, "source"));
      order.set(row.filename, -1);
    }
  }

  const linked = db
    .query<PhotoRow, [string]>(
      `SELECT m.*, msg.sent_at, msg.author, msg.body, tm.position
         FROM task_media tm
         JOIN whatsapp_media m ON m.id = tm.media_id
         LEFT JOIN whatsapp_messages msg ON msg.media_id = m.id
        WHERE tm.task_id = ?
        ORDER BY tm.position`,
    )
    .all(taskId);
  for (const row of linked) {
    // Keyed by filename: the same photo read by two imports is one photo.
    if (photos.has(row.filename) || !showable(row)) continue;
    photos.set(row.filename, toTaskPhoto(row, "linked"));
    order.set(row.filename, row.position ?? 0);
  }

  // Chat order, because that is the order the person explaining the problem
  // sent them in; the link position breaks ties.
  return [...photos.values()].sort(
    (a, b) =>
      (a.sentAt ?? "").localeCompare(b.sentAt ?? "") || (order.get(a.filename) ?? 0) - (order.get(b.filename) ?? 0),
  );
}

/**
 * Attaches photos from a WhatsApp import to a card. Only photos, only ones that
 * were kept, and only from an import on the card's own board — a screenshot from
 * another board's chat on this card would be a leak between boards, not a link.
 * Linking one already linked is a no-op; `replace` swaps the whole set.
 */
export function linkTaskPhotos(
  taskId: string,
  mediaIds: string[],
  actor: ActorContext,
  options: { replace?: boolean } = {},
): TaskPhoto[] {
  const db = getDb();
  const task = db.query<{ board_id: string }, [string]>("SELECT board_id FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw notFound("task", taskId);

  const ids = [...new Set(mediaIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0 && !options.replace) throw badRequest("name at least one photo (a wam_… id from whatsapp_claim)");
  if (ids.length > MAX_LINKED_PHOTOS) throw badRequest(`at most ${MAX_LINKED_PHOTOS} photos per card`);

  const rows = ids.length
    ? db
        .query<WhatsAppMediaRow, SQLQueryBindings[]>(
          `SELECT * FROM whatsapp_media WHERE id IN (${ids.map(() => "?").join(", ")})`,
        )
        .all(...ids)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const problems: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) problems.push(`${id} does not exist`);
    else if (row.board_id !== task.board_id) problems.push(`${id} came from another board's chat`);
    else if (row.kind !== "photo") problems.push(`${id} (${row.filename}) is a ${row.kind}, and only photos go on a card`);
    else if (!row.path) problems.push(`${id} (${row.filename}) was too large to keep`);
  }
  if (problems.length > 0) throw badRequest(`cannot link: ${problems.join("; ")}`, { taskId, problems });

  write((db) => {
    if (options.replace) db.run("DELETE FROM task_media WHERE task_id = ?", [taskId]);
    const next =
      db.query<{ top: number | null }, [string]>("SELECT MAX(position) AS top FROM task_media WHERE task_id = ?").get(taskId)
        ?.top ?? -1;
    const now = new Date().toISOString();
    ids.forEach((id, index) => {
      db.run("INSERT OR IGNORE INTO task_media (task_id, media_id, position, created_at) VALUES (?, ?, ?, ?)", [
        taskId,
        id,
        next + 1 + index,
        now,
      ]);
    });
    record(db, actor, "task.photos_linked", { boardId: task.board_id, taskId }, { photos: ids, replace: Boolean(options.replace) });
  });
  log.info("photos linked to card", { taskId, photos: ids.length, replace: Boolean(options.replace), actor: actor.actorId });
  return listTaskPhotos(taskId);
}

