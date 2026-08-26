import { Router } from "express";
import {
  addCommentWithMentions,
  deleteTask,
  getTaskDetail,
  listActivity,
  listComments,
  listMentions,
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
tasksRouter.post(
  "/:taskId/comments",
  route((req, res) => {
    const { comment, mentions } = addCommentWithMentions(
      param(req, "taskId"),
      String(req.body?.body ?? ""),
      actorFrom(req),
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
