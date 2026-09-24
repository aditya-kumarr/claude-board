import { Router, raw } from "express";
import { createReadStream } from "node:fs";
import {
  cancelWhatsAppImport,
  deleteWhatsAppChat,
  deleteWhatsAppImport,
  getWhatsAppImport,
  getWhatsAppMedia,
  getWhatsAppSummary,
  listWhatsAppChats,
  listWhatsAppImports,
  notFound,
  uploadWhatsAppExport,
  WHATSAPP_MAX_UPLOAD_BYTES,
  whatsappMediaExists,
  whatsappMediaPath,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, boolQuery, param } from "./helpers.ts";

/**
 * A board's WhatsApp chats: upload an export, get cards for what is new in it.
 *
 * Uploading only *queues*, as the intake chat does — this process parses the zip
 * and fixes the window, and an agent run decides what in it is work.
 *
 * The body is the zip itself, not JSON. An export with media is routinely tens of
 * megabytes, and base64 inside JSON (intake's approach, fine for six files) would
 * add a third again and hold two copies in memory. The few settings travel in the
 * query string instead, which also keeps the endpoint usable from `curl --data-binary`.
 */
export const whatsappRouter: Router = Router({ mergeParams: true });

const uploadBody = raw({ type: () => true, limit: WHATSAPP_MAX_UPLOAD_BYTES });

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

whatsappRouter.get(
  "/",
  route((req, res) => {
    const boardId = param(req, "boardId");
    res.json({
      chats: listWhatsAppChats(boardId),
      imports: listWhatsAppImports({ boardId, includeArchivedBoards: true, limit: Number(req.query.limit) || 100 }),
      summary: getWhatsAppSummary(boardId),
    });
  }),
);

whatsappRouter.post(
  "/",
  uploadBody,
  route((req, res) => {
    const data = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
    const result = uploadWhatsAppExport(
      param(req, "boardId"),
      {
        filename: text(req.query.filename) ?? "WhatsApp Chat.zip",
        data,
        instruction: text(req.query.instruction),
        readPhotos: boolQuery(req.query.readPhotos),
        chat: text(req.query.chat),
        selfName: text(req.query.selfName),
        since: text(req.query.since),
      },
      actorFrom(req),
    );
    res.status(202).json(result);
  }),
);

whatsappRouter.delete(
  "/chats/:chatId",
  route((req, res) => {
    res.json(deleteWhatsAppChat(param(req, "chatId"), actorFrom(req)));
  }),
);

/* ---- one import or file, mounted at /api/whatsapp ---- */

export const whatsappItemsRouter: Router = Router();

whatsappItemsRouter.get(
  "/imports/:importId",
  route((req, res) => {
    res.json(getWhatsAppImport(param(req, "importId")));
  }),
);

/** Drops an open import, so one left by a dead run cannot block the chat's next upload. */
whatsappItemsRouter.post(
  "/imports/:importId/cancel",
  route((req, res) => {
    res.json(cancelWhatsAppImport(param(req, "importId"), String(req.body?.reason ?? "cancelled from the board"), actorFrom(req)));
  }),
);

whatsappItemsRouter.delete(
  "/imports/:importId",
  route((req, res) => {
    res.json(deleteWhatsAppImport(param(req, "importId"), actorFrom(req)));
  }),
);

/** Streams a kept photo back for the panel's thumbnails. `nosniff` for the same reason intake sets it. */
whatsappItemsRouter.get(
  "/media/:mediaId/content",
  route((req, res) => {
    const media = getWhatsAppMedia(param(req, "mediaId"));
    if (!whatsappMediaExists(media)) throw notFound("whatsapp media file", media.id);
    const ext = media.filename.split(".").pop()?.toLowerCase() ?? "";
    const type = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : ext === "heic" ? "image/heic" : "image/jpeg";
    res.setHeader("content-type", type);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-disposition", `inline; filename="${media.filename.replace(/[^\w.\-]+/g, "_")}"`);
    createReadStream(whatsappMediaPath(media)!).pipe(res);
  }),
);
