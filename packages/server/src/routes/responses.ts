import { Router } from "express";
import {
  cancelResponseTurn,
  deleteResponse,
  getResponse,
  getTaskResponseSummary,
  listResponses,
  listResponseTurns,
  notFound,
  requestResponseDrafts,
  requestResponseRevision,
  setResponseStatus,
  updateResponse,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, boolQuery, param } from "./helpers.ts";

/**
 * Draft replies and the conversation about them.
 *
 * Two of these routes queue rather than act: asking for a rewrite and asking for a
 * card's first drafts both need Claude, and this process has no model access. They
 * answer `202` (or `200` with `alreadyQueued`) for the same reason the Sync button
 * does — saying "asked" when nothing has been written yet is the honest answer.
 *
 * Nothing here sends a message. There is deliberately no send route: marking a
 * reply `sent` records that the user sent it themselves.
 */
export const responsesRouter: Router = Router();

/** Cross-board draft query, for a future "replies I owe" view and for debugging. */
responsesRouter.get(
  "/",
  route((req, res) => {
    const { taskId, boardId, channel, stage, status, limit } = req.query;
    res.json({
      responses: listResponses({
        taskId: typeof taskId === "string" ? taskId : undefined,
        boardId: typeof boardId === "string" ? boardId : undefined,
        channel: typeof channel === "string" ? channel : undefined,
        stage: typeof stage === "string" ? stage : undefined,
        status: typeof status === "string" ? (status as never) : undefined,
        dueNowOnly: boolQuery(req.query.dueNowOnly),
        limit: Number(limit) || undefined,
      }),
    });
  }),
);

responsesRouter.get(
  "/:responseId",
  route((req, res) => {
    res.json(getResponse(param(req, "responseId")));
  }),
);

/**
 * Hand edits. Content only — `status` moves through its own route because the
 * transitions are rules rather than a field, and because an edit is recorded in
 * the message's thread while approving it is not.
 */
responsesRouter.patch(
  "/:responseId",
  route((req, res) => {
    res.json(updateResponse(param(req, "responseId"), req.body ?? {}, actorFrom(req)));
  }),
);

responsesRouter.post(
  "/:responseId/status",
  route((req, res) => {
    res.json(setResponseStatus(param(req, "responseId"), String(req.body?.status ?? ""), actorFrom(req)));
  }),
);

/**
 * Queues a rewrite. This is what the chat box under a message posts, so the
 * response carries the queued turn: the UI shows it in the thread immediately as
 * "asked", and fills in Claude's reply when the revision poll sees it land.
 */
responsesRouter.post(
  "/:responseId/revise",
  route((req, res) => {
    const result = requestResponseRevision(
      param(req, "responseId"),
      String(req.body?.instruction ?? ""),
      actorFrom(req),
    );
    res.status(result.alreadyQueued ? 200 : 202).json(result);
  }),
);

/**
 * Drops the outstanding rewrite. The composer is disabled while one is in flight,
 * so without this a turn left behind by a dead run would wedge the message.
 */
responsesRouter.delete(
  "/:responseId/turn",
  route((req, res) => {
    const responseId = param(req, "responseId");
    const [active] = listResponseTurns({ responseId, oldestFirst: true, limit: 1 });
    if (!active) throw notFound("outstanding change for this reply");
    res.json(cancelResponseTurn(active.id, String(req.body?.reason ?? "cancelled from the board"), actorFrom(req)));
  }),
);

responsesRouter.delete(
  "/:responseId",
  route((req, res) => {
    res.json(deleteResponse(param(req, "responseId"), actorFrom(req)));
  }),
);

/* ---- a card's replies, mounted under /api/tasks/:taskId ---- */

/** `mergeParams` so `:taskId` from the parent mount reaches `param()`. */
export const taskResponsesRouter: Router = Router({ mergeParams: true });

taskResponsesRouter.get(
  "/",
  route((req, res) => {
    res.json(getTaskResponseSummary(param(req, "taskId")));
  }),
);

/** Queues a first pass of drafts, for a card a sync did not write them for. */
taskResponsesRouter.post(
  "/draft",
  route((req, res) => {
    const result = requestResponseDrafts(
      param(req, "taskId"),
      typeof req.body?.instruction === "string" ? req.body.instruction : undefined,
      actorFrom(req),
    );
    res.status(result.alreadyQueued ? 200 : 202).json(result);
  }),
);

taskResponsesRouter.delete(
  "/draft",
  route((req, res) => {
    const taskId = param(req, "taskId");
    const [active] = listResponseTurns({ taskId, kind: "draft", oldestFirst: true, limit: 1 });
    if (!active) throw notFound("outstanding draft request for this task");
    res.json(cancelResponseTurn(active.id, String(req.body?.reason ?? "cancelled from the board"), actorFrom(req)));
  }),
);
