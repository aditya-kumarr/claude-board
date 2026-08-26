import { Router, json } from "express";
import { createReadStream } from "node:fs";
import {
  attachmentExists,
  attachmentPath,
  cancelIntakeMessage,
  deleteIntakeMessage,
  getIntakeAttachment,
  getIntakeMessage,
  getIntakeSummary,
  listIntakeMessages,
  notFound,
  postIntakeMessage,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, param } from "./helpers.ts";

/**
 * The board's intake chat: paste a CSV, a note, a thread or a screenshot and get
 * cards back.
 *
 * Posting only *queues*. This process has no model access, so it answers `202` with
 * a pending message and an agent run turns it into cards — the same bargain the
 * Sync button and the reply panel live with. `rejected` comes back alongside, so a
 * file that could not be used is named at the moment it was dropped rather than
 * becoming a run that reports failure minutes later.
 *
 * The POST route carries its own body limit. Attachments arrive as base64 inside
 * the JSON — which avoids a multipart dependency for a handful of files — and the
 * app-wide 256kb ceiling would reject a screenshot before it was ever read.
 */
export const intakeRouter: Router = Router({ mergeParams: true });

/** Six 10MB files plus base64's third again, with room for the typed instruction. */
const uploadBody = json({ limit: "88mb" });

intakeRouter.get(
  "/",
  route((req, res) => {
    const boardId = param(req, "boardId");
    res.json({
      messages: listIntakeMessages({
        boardId,
        includeArchivedBoards: true,
        limit: Number(req.query.limit) || 100,
      }),
      summary: getIntakeSummary(boardId),
    });
  }),
);

intakeRouter.post(
  "/",
  uploadBody,
  route((req, res) => {
    const result = postIntakeMessage(param(req, "boardId"), req.body ?? {}, actorFrom(req));
    res.status(202).json(result);
  }),
);

/**
 * Drops the outstanding message. The composer is disabled while one is in flight,
 * so without this a message left by a dead run would wedge the chat.
 */
intakeRouter.delete(
  "/pending",
  route((req, res) => {
    const boardId = param(req, "boardId");
    const [open] = listIntakeMessages({
      boardId,
      status: ["pending", "claimed"],
      includeArchivedBoards: true,
      limit: 1,
    });
    if (!open) throw notFound("outstanding intake message for this board");
    res.json(cancelIntakeMessage(open.id, String(req.body?.reason ?? "cancelled from the board"), actorFrom(req)));
  }),
);

/* ---- one message, mounted at /api/intake ---- */

export const intakeMessagesRouter: Router = Router();

intakeMessagesRouter.get(
  "/messages/:messageId",
  route((req, res) => {
    res.json(getIntakeMessage(param(req, "messageId")));
  }),
);

intakeMessagesRouter.delete(
  "/messages/:messageId",
  route((req, res) => {
    res.json(deleteIntakeMessage(param(req, "messageId"), actorFrom(req)));
  }),
);

/**
 * Streams an attachment back. Needed so the chat can show a screenshot as a
 * thumbnail rather than as a filename — a pasted image the user cannot see again
 * is a pasted image they cannot check was the right one.
 *
 * `Content-Disposition: inline` with the original filename, and `nosniff`, so the
 * browser renders an image and never executes a pasted `.html` as a page.
 */
intakeMessagesRouter.get(
  "/attachments/:attachmentId/content",
  route((req, res) => {
    const attachment = getIntakeAttachment(param(req, "attachmentId"));
    if (!attachmentExists(attachment)) throw notFound("attachment file", attachment.id);
    res.setHeader("content-type", attachment.kind === "image" ? attachment.mime : attachment.kind === "pdf" ? "application/pdf" : "text/plain; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-length", String(attachment.bytes));
    res.setHeader(
      "content-disposition",
      `inline; filename="${attachment.filename.replace(/[^\w.\-]+/g, "_")}"`,
    );
    createReadStream(attachmentPath(attachment)).pipe(res);
  }),
);
