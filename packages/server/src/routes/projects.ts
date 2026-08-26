import { Router } from "express";
import { createProject, deleteProject, listProjects, updateProject } from "@automation/core";
import { route } from "../middleware/errors.ts";
import { actorFrom, boolQuery, param } from "./helpers.ts";

/**
 * Directories on this machine that work can be delegated into.
 *
 * Top-level rather than nested under a board, because a project outlives any one
 * board: the same checkout is the target of this week's board and next week's.
 */
export const projectsRouter: Router = Router();

projectsRouter.get(
  "/",
  route((req, res) => {
    res.json({ projects: listProjects({ includeArchived: boolQuery(req.query.includeArchived) }) });
  }),
);

/**
 * Registering validates the path *here*, so a typo comes back into the dialog the
 * user is looking at rather than killing an agent run half an hour later.
 */
projectsRouter.post(
  "/",
  route((req, res) => {
    res.status(201).json(createProject(req.body ?? {}, actorFrom(req)));
  }),
);

projectsRouter.patch(
  "/:projectId",
  route((req, res) => {
    res.json(updateProject(param(req, "projectId"), req.body ?? {}, actorFrom(req)));
  }),
);

/** Unregisters the directory. Nothing on disk is touched and no card is deleted. */
projectsRouter.delete(
  "/:projectId",
  route((req, res) => {
    res.json(deleteProject(param(req, "projectId"), actorFrom(req)));
  }),
);
