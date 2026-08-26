import { Router } from "express";
import {
  addColumn,
  createBoard,
  createTask,
  deleteBoard,
  deleteColumn,
  cancelSyncRun,
  getBoardDetail,
  getSyncSummary,
  listActivity,
  listBoards,
  listColumns,
  listSyncRuns,
  notFound,
  requestSync,
  updateBoard,
  updateColumn,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, param } from "./helpers.ts";

export const boardsRouter: Router = Router();

boardsRouter.get(
  "/",
  route((req, res) => {
    res.json({ boards: listBoards({ includeArchived: req.query.includeArchived === "true" }) });
  }),
);

boardsRouter.post(
  "/",
  route((req, res) => {
    res.status(201).json(createBoard(req.body ?? {}, actorFrom(req)));
  }),
);

boardsRouter.get(
  "/:boardId",
  route((req, res) => {
    res.json(getBoardDetail(param(req, "boardId")));
  }),
);

boardsRouter.patch(
  "/:boardId",
  route((req, res) => {
    res.json(updateBoard(param(req, "boardId"), req.body ?? {}, actorFrom(req)));
  }),
);

boardsRouter.delete(
  "/:boardId",
  route((req, res) => {
    res.json(deleteBoard(param(req, "boardId"), actorFrom(req)));
  }),
);

boardsRouter.get(
  "/:boardId/activity",
  route((req, res) => {
    res.json({ activity: listActivity({ boardId: param(req, "boardId"), limit: Number(req.query.limit) || 50 }) });
  }),
);

/* ---- inbox sync ---- */

/**
 * Queues a sync; it does not perform one. This process has no Microsoft Graph
 * credentials — that access lives in the MS365 MCP server, which an agent talks
 * to — so the honest thing to return is the queued request, and `202` rather
 * than `200`. `alreadyQueued` tells the UI a double-tap did not stack a run.
 */
boardsRouter.post(
  "/:boardId/sync",
  route((req, res) => {
    const result = requestSync(param(req, "boardId"), req.body ?? {}, actorFrom(req));
    res.status(result.alreadyQueued ? 200 : 202).json(result);
  }),
);

boardsRouter.get(
  "/:boardId/sync",
  route((req, res) => {
    const boardId = param(req, "boardId");
    res.json({
      ...getSyncSummary(boardId),
      runs: listSyncRuns({ boardId, limit: Number(req.query.limit) || 10 }),
    });
  }),
);

/**
 * Drops the outstanding request. Needed because a queued sync with nothing
 * listening would otherwise wedge the board: the button is disabled while a run
 * is outstanding, so without this there is no way back.
 */
boardsRouter.delete(
  "/:boardId/sync",
  route((req, res) => {
    const boardId = param(req, "boardId");
    const { activeRun } = getSyncSummary(boardId);
    if (!activeRun) throw notFound("outstanding sync for this board");
    res.json(cancelSyncRun(activeRun.id, String(req.body?.reason ?? "cancelled from the board"), actorFrom(req)));
  }),
);

/* ---- columns (task states) live under their board ---- */

boardsRouter.get(
  "/:boardId/columns",
  route((req, res) => {
    res.json({ columns: listColumns(param(req, "boardId")) });
  }),
);

boardsRouter.post(
  "/:boardId/columns",
  route((req, res) => {
    res.status(201).json(addColumn(param(req, "boardId"), req.body ?? {}, actorFrom(req)));
  }),
);

boardsRouter.patch(
  "/:boardId/columns/:columnId",
  route((req, res) => {
    res.json(updateColumn(param(req, "columnId"), req.body ?? {}, actorFrom(req)));
  }),
);

boardsRouter.delete(
  "/:boardId/columns/:columnId",
  route((req, res) => {
    res.json(
      deleteColumn(
        param(req, "columnId"),
        { moveTasksTo: typeof req.query.moveTasksTo === "string" ? req.query.moveTasksTo : undefined },
        actorFrom(req),
      ),
    );
  }),
);

boardsRouter.post(
  "/:boardId/tasks",
  route((req, res) => {
    res.status(201).json(createTask(param(req, "boardId"), req.body ?? {}, actorFrom(req)));
  }),
);
