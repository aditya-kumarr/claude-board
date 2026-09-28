import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { getDb } from "../db/index.ts";
import { toComment, type CommentRow } from "../db/rows.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { COMMENT_FILES_DIR } from "../lib/paths.ts";
import type { CommentAttachment, CommentKind, TaskComment } from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

/**
 * Comment persistence, with no knowledge of tasks or mentions. Kept as its own
 * leaf so both `addComment` (which parses mentions out of what the human wrote)
 * and `resolveMention` (which writes Claude's reply back into the thread) can
 * append to a thread without the two services importing each other.
 */

/** A comment's text. Empty is allowed only when the comment carries images. */
export function requireCommentBody(value: unknown, hasImages = false): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text && !hasImages) throw badRequest("comment body is required");
  if (text.length > 4000) throw badRequest("comment must be 4000 characters or fewer");
  return text;
}

/* ------------------------------------------------------------------ images */

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** What the Read tool can look at — the reason a thread takes images and not files. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** An image on its way into a comment. The transports decode it; core decides if it is usable. */
export interface CommentImageUpload {
  filename: string;
  bytes: Uint8Array;
  /** Advisory. The extension decides, except for an unnamed clipboard paste. */
  mime?: string;
}

/** An image checked and written to disk, waiting for its row. */
export interface StagedImage extends Omit<CommentAttachment, "commentId"> {
  absolute: string;
}

/**
 * Checks every image and writes it to disk, before any row exists. All or
 * nothing: one bad file refuses the comment with the reason, rather than posting
 * the text with a silently missing screenshot the thread then refers to.
 */
export function stageCommentImages(
  target: { taskId: string; boardId: string },
  uploads: CommentImageUpload[],
): StagedImage[] {
  if (uploads.length > MAX_IMAGES) throw badRequest(`at most ${MAX_IMAGES} images per comment`, { received: uploads.length });
  const staged: StagedImage[] = [];
  try {
    for (const upload of uploads) {
      const filename = (upload.filename ?? "").trim() || "pasted-image.png";
      let ext = extname(filename).toLowerCase();
      // A screenshot pasted off the clipboard often arrives unnamed; trust its type then.
      if (!IMAGE_TYPES[ext] && upload.mime) {
        ext = Object.entries(IMAGE_TYPES).find(([, mime]) => mime === upload.mime)?.[0] ?? ext;
      }
      const mime = IMAGE_TYPES[ext];
      if (!mime) throw badRequest(`${filename} is not an image a comment can hold — use PNG, JPEG, GIF or WebP`, { filename });
      if (!upload.bytes || upload.bytes.byteLength === 0) throw badRequest(`${filename} is empty`, { filename });
      if (upload.bytes.byteLength > MAX_IMAGE_BYTES) {
        throw badRequest(`${filename} is ${Math.round(upload.bytes.byteLength / 1024 / 1024)}MB; the limit is 10MB`, { filename });
      }
      const id = newId("cat");
      const path = `${target.boardId}/${target.taskId}/${id}${ext}`;
      const absolute = resolve(COMMENT_FILES_DIR, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, upload.bytes);
      staged.push({ id, filename, mime, bytes: upload.bytes.byteLength, path, absolute });
    }
  } catch (error) {
    discardCommentImages(staged);
    throw error;
  }
  return staged;
}

/** Removes staged files whose comment never got written. */
export function discardCommentImages(staged: StagedImage[]): void {
  for (const file of staged) {
    try {
      rmSync(file.absolute, { force: true });
    } catch {
      // Best effort; a stray file is not worth masking the real error.
    }
  }
}

/** Absolute location of an attachment, for serving it and for telling a run where to Read it. */
export const commentAttachmentPath = (attachment: Pick<CommentAttachment, "path">): string =>
  resolve(COMMENT_FILES_DIR, attachment.path);

export function getCommentAttachment(attachmentId: string): CommentAttachment {
  const row = getDb()
    .query<{ id: string; comment_id: string; filename: string; mime: string; bytes: number; path: string }, [string]>(
      "SELECT id, comment_id, filename, mime, bytes, path FROM comment_attachments WHERE id = ?",
    )
    .get(attachmentId);
  if (!row) throw notFound("comment attachment", attachmentId);
  return { id: row.id, commentId: row.comment_id, filename: row.filename, mime: row.mime, bytes: row.bytes, path: row.path };
}

/**
 * Removes the files of a card's comments, or a whole board's. The rows go by
 * cascade; the bytes are this module's to clean up, and the folder layout makes
 * it one directory either way.
 */
export function removeCommentFiles(target: { boardId: string; taskId?: string }): void {
  try {
    rmSync(resolve(COMMENT_FILES_DIR, target.boardId, ...(target.taskId ? [target.taskId] : [])), {
      recursive: true,
      force: true,
    });
  } catch {
    // The rows are gone either way; leftover files are not worth failing a delete.
  }
}

/**
 * Appends one comment inside the caller's transaction.
 *
 * `kind` defaults to `note`, which is what a person writing in the box means and
 * what every comment was before migration 10. The other kinds are Claude
 * narrating a job — see `CommentKind`.
 */
export function insertComment(
  db: Database,
  target: { taskId: string; boardId: string },
  body: string,
  actor: ActorContext,
  kind: CommentKind = "note",
  staged: StagedImage[] = [],
): TaskComment {
  // Images are staged by the caller *before* its transaction, so it can remove
  // them if anything later in that transaction fails — not just this insert.
  const text = requireCommentBody(body, staged.length > 0);
  const id = newId("cmt");
  const createdAt = new Date().toISOString();

  db.run("INSERT INTO task_comments (id, task_id, author_id, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    target.taskId,
    actor.actorId,
    text,
    kind,
    createdAt,
  ]);
  for (const file of staged) {
    db.run(
      `INSERT INTO comment_attachments (id, comment_id, task_id, filename, mime, bytes, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [file.id, id, target.taskId, file.filename, file.mime, file.bytes, file.path, createdAt],
    );
  }
  // `kind` rides in the activity detail because the audit trail is where "when
  // did it say it was stuck" gets answered after the fact.
  record(db, actor, "task.commented", target, { commentId: id, kind, chars: text.length, images: staged.length });

  return {
    id,
    taskId: target.taskId,
    authorId: actor.actorId,
    body: text,
    kind,
    createdAt,
    attachments: staged.map(({ absolute: _absolute, ...file }) => ({ ...file, commentId: id })),
  };
}

/**
 * Resolves the board a task sits on, and 404s if the task is gone. Duplicated
 * from `getTask` on purpose: this module stays a leaf, and the alternative is an
 * import cycle with the task service.
 */
export function commentTarget(taskId: string): { taskId: string; boardId: string } {
  const row = getDb().query<{ board_id: string }, [string]>("SELECT board_id FROM tasks WHERE id = ?").get(taskId);
  if (!row) throw notFound("task", taskId);
  return { taskId, boardId: row.board_id };
}

export function listComments(taskId: string): TaskComment[] {
  commentTarget(taskId);
  const db = getDb();
  const comments = db
    .query<CommentRow, [string]>("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId)
    .map(toComment);
  if (comments.length === 0) return comments;

  // One read for the whole thread's images rather than one per comment.
  const rows = db
    .query<{ id: string; comment_id: string; filename: string; mime: string; bytes: number; path: string }, SQLQueryBindings[]>(
      "SELECT id, comment_id, filename, mime, bytes, path FROM comment_attachments WHERE task_id = ? ORDER BY rowid",
    )
    .all(taskId);
  const byComment = new Map<string, CommentAttachment[]>();
  for (const row of rows) {
    const list = byComment.get(row.comment_id) ?? [];
    list.push({ id: row.id, commentId: row.comment_id, filename: row.filename, mime: row.mime, bytes: row.bytes, path: row.path });
    byComment.set(row.comment_id, list);
  }
  return comments.map((comment) => ({ ...comment, attachments: byComment.get(comment.id) ?? [] }));
}
