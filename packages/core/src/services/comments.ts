import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { toComment, type CommentRow } from "../db/rows.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { CommentKind, TaskComment } from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

/**
 * Comment persistence, with no knowledge of tasks or mentions. Kept as its own
 * leaf so both `addComment` (which parses mentions out of what the human wrote)
 * and `resolveMention` (which writes Claude's reply back into the thread) can
 * append to a thread without the two services importing each other.
 */

export function requireCommentBody(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("comment body is required");
  const text = value.trim();
  if (text.length > 4000) throw badRequest("comment must be 4000 characters or fewer");
  return text;
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
): TaskComment {
  const text = requireCommentBody(body);
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
  // `kind` rides in the activity detail because the audit trail is where "when
  // did it say it was stuck" gets answered after the fact.
  record(db, actor, "task.commented", target, { commentId: id, kind, chars: text.length });

  return { id, taskId: target.taskId, authorId: actor.actorId, body: text, kind, createdAt };
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
  return getDb()
    .query<CommentRow, [string]>("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId)
    .map(toComment);
}
