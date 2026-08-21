import { Router } from "express";
import {
  addComment,
  deleteTask,
  getTaskDetail,
  listActivity,
  listComments,
  listTasks,
  moveTask,
  updateTask,
} from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, boolQuery, param } from "./helpers.ts";

export const tasksRouter: Router = Router();

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

tasksRouter.post(
  "/:taskId/comments",
  route((req, res) => {
    res.status(201).json(addComment(param(req, "taskId"), String(req.body?.body ?? ""), actorFrom(req)));
  }),
);

tasksRouter.get(
  "/:taskId/activity",
  route((req, res) => {
    res.json({ activity: listActivity({ taskId: param(req, "taskId"), limit: Number(req.query.limit) || 50 }) });
  }),
);
