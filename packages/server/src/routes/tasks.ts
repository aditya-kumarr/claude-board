import { Router, json } from "express";
import { createReadStream, existsSync } from "node:fs";
import {
  addCommentWithMentions,
  badRequest,
  commentAttachmentPath,
  getCommentAttachment,
  notFound,
  type CommentImageUpload,
  deleteTask,
  getTaskDetail,
  listActivity,
  listComments,
  listMentions,
  listTaskPhotos,
  listTasks,
  MENTION_STATUSES,
  moveTask,
  updateTask,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, boolQuery, param } from "./helpers.ts";
import { taskResponsesRouter } from "./responses.ts";

export const tasksRouter: Router = Router();

/**
 * A card's draft replies. Mounted before `/:taskId` so "responses" is never read
 * as a task id, and nested so `:taskId` stays visible to the child router.
 */
tasksRouter.use("/:taskId/responses", taskResponsesRouter);

/**
 * Photos from the WhatsApp chat a card came out of, for the detail view's
 * carousel. Fetched on its own rather than read off the board, because linking a
 * photo does not touch the task row — the dialog refetches on the revision poll.
 */
tasksRouter.get(
  "/:taskId/photos",
  route((req, res) => {
    res.json({ photos: listTaskPhotos(param(req, "taskId")) });
  }),
);

/**
 * Streams a comment image back. Registered before `/:taskId` routes so the word
 * "attachments" is never read as a task id. `nosniff` and an image type only,
 * so nothing uploaded here can be rendered as a page.
 */
tasksRouter.get(
  "/attachments/:attachmentId/content",
  route((req, res) => {
    const attachment = getCommentAttachment(param(req, "attachmentId"));
    const path = commentAttachmentPath(attachment);
    if (!existsSync(path)) throw notFound("comment image file", attachment.id);
    res.setHeader("content-type", attachment.mime);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-disposition", `inline; filename="${attachment.filename.replace(/[^\w.\-]+/g, "_")}"`);
    createReadStream(path).pipe(res);
  }),
);

/** Cross-board task query — powers both the UI's "My work" view and the agent's queue. */
tasksRouter.get(
  "/",
  route((req, res) => {
    const { assignee, boardId, column, columnKind, priority, search, limit } = req.query;
    res.json({
      tasks: listTasks({
        boardId: typeof boardId === "string" ? boardId : undefined,
        assignee: assignee === "none" ? null : typeof assignee === "string" ? assignee : undefined,
        column: typeof column === "string" ? column : undefined,
        columnKind: typeof columnKind === "string" ? columnKind : undefined,
        priority: typeof priority === "string" ? priority : undefined,
        search: typeof search === "string" ? search : undefined,
        overdueOnly: boolQuery(req.query.overdueOnly),
        includeDone: boolQuery(req.query.includeDone),
        includeArchivedBoards: boolQuery(req.query.includeArchivedBoards),
        limit: Number(limit) || undefined,
      }),
    });
  }),
);

tasksRouter.get(
  "/:taskId",
  route((req, res) => {
    res.json(getTaskDetail(param(req, "taskId")));
  }),
);

tasksRouter.patch(
  "/:taskId",
  route((req, res) => {
    res.json(updateTask(param(req, "taskId"), req.body ?? {}, actorFrom(req)));
  }),
);

tasksRouter.post(
  "/:taskId/move",
  route((req, res) => {
    res.json(moveTask(param(req, "taskId"), req.body ?? {}, actorFrom(req)));
  }),
);

tasksRouter.delete(
  "/:taskId",
  route((req, res) => {
    res.json(deleteTask(param(req, "taskId"), actorFrom(req)));
  }),
);

tasksRouter.get(
  "/:taskId/comments",
  route((req, res) => {
    res.json({ comments: listComments(param(req, "taskId")) });
  }),
);

/**
 * Returns the mentions the comment raised alongside it, so the UI can tell the
 * user their `@claude` was actually registered as a request rather than leaving
 * them to guess from a highlighted word.
 */
/** Six 10MB images plus base64's third again. The app-wide limit skips this route. */
const commentBody = json({ limit: "88mb" });

/**
 * Images arrive as base64 inside the JSON, as the intake chat's do. Decoded here
 * and nowhere else: core validates bytes, and a web client is never able to name
 * a file on this machine for the server to read — only the MCP tool can do that.
 */
function decodeImages(raw: unknown): CommentImageUpload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest("images must be a list");
  return raw.map((entry: { filename?: unknown; mime?: unknown; data?: unknown }) => {
    if (typeof entry?.data !== "string") throw badRequest("each image needs its data as base64");
    return {
      filename: typeof entry.filename === "string" ? entry.filename : "",
      mime: typeof entry.mime === "string" ? entry.mime : undefined,
      bytes: new Uint8Array(Buffer.from(entry.data, "base64")),
    };
  });
}

tasksRouter.post(
  "/:taskId/comments",
  commentBody,
  route((req, res) => {
    const { comment, mentions } = addCommentWithMentions(
      param(req, "taskId"),
      String(req.body?.body ?? ""),
      actorFrom(req),
      "note",
      decodeImages(req.body?.images),
    );
    res.status(201).json({ ...comment, mentions });
  }),
);

/**
 * The whole mention history for one card, not just the open ones — the thread
 * view renders a status against each `@claude` the user ever wrote, including
 * the answered ones.
 */
tasksRouter.get(
  "/:taskId/mentions",
  route((req, res) => {
    res.json({
      mentions: listMentions({
        taskId: param(req, "taskId"),
        status: typeof req.query.status === "string" ? (req.query.status as never) : MENTION_STATUSES,
        includeArchivedBoards: true,
      }),
    });
  }),
);

tasksRouter.get(
  "/:taskId/activity",
  route((req, res) => {
    res.json({ activity: listActivity({ taskId: param(req, "taskId"), limit: Number(req.query.limit) || 50 }) });
  }),
);
