import { Router } from "express";
import {
  addColumn,
  createBoard,
  createTask,
  deleteBoard,
  deleteColumn,
  buildBoardExport,
  cancelSyncRun,
  getBoardDetail,
  getSyncSummary,
  listActivity,
  listBoards,
  listColumns,
  listSyncRuns,
  notFound,
  requestSync,
  toCsv,
  updateBoard,
  updateColumn,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { boardToXlsx } from "../lib/xlsx.ts";
import { actorFrom, param } from "./helpers.ts";
import { intakeRouter } from "./intake.ts";

export const boardsRouter: Router = Router();

/**
 * The board's intake chat. Nested so `:boardId` stays visible to the child router,
 * which needs its own body limit for base64 attachments.
 */
boardsRouter.use("/:boardId/intake", intakeRouter);

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

/**
 * The board as a spreadsheet. `format=xlsx` gets headings, dropdowns on the
 * fixed-set columns and real dates; `csv` gets the same table as plain text.
 *
 * Served as a download rather than JSON because the point is to open it: the
 * filename carries the board and the date, so a folder of these stays legible.
 */
boardsRouter.get(
  "/:boardId/export",
  route(async (req, res) => {
    // buildBoardExport 404s on an unknown board itself, so there is nothing to
    // check first — and getBoardDetail here would compute stats, mentions and the
    // sync summary that the export does not use.
    const data = buildBoardExport(param(req, "boardId"));
    const stamp = data.generatedAt.slice(0, 10);
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const filename = `${data.slug}-${stamp}.${format}`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // The filename is derived from a user-supplied board name, so it is quoted
    // above and the slug strips anything but [a-z0-9-] — a header cannot carry a
    // stray quote or newline out of a board title.
    if (format === "xlsx") {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.send(await boardToXlsx(data));
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send(toCsv(data, { includeSummary: req.query.summary === "true" }));
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
