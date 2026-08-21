import { Router } from "express";
import {
  addColumn,
  createBoard,
  createTask,
  deleteBoard,
  deleteColumn,
  getBoardDetail,
  listActivity,
  listBoards,
  listColumns,
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
