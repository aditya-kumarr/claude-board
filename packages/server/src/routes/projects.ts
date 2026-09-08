import { Router } from "express";
import { createProject, deleteProject, listProjects, projectUsage, updateProject } from "@automation/core";
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
  route((_req, res) => {
    res.json({ projects: listProjects() });
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

/**
 * What a delete would take with it. Read *before* the act: a project has no
 * archived state, so the only way out is a cascade, and the dialog has to be able
 * to name the boards and cards it is about to remove before the user consents.
 */
projectsRouter.get(
  "/:projectId/usage",
  route((req, res) => {
    res.json(projectUsage(param(req, "projectId")));
  }),
);

projectsRouter.patch(
  "/:projectId",
  route((req, res) => {
    res.json(updateProject(param(req, "projectId"), req.body ?? {}, actorFrom(req)));
  }),
);

/**
 * Deletes the project **and** every board and card that pointed at it. Nothing on
 * disk is touched. `confirmCascade=true` is required whenever anything points at
 * it — core refuses with a 409 carrying the counts otherwise, which is what keeps
 * the checkbox in the UI from being the only thing standing between a click and a
 * board.
 */
projectsRouter.delete(
  "/:projectId",
  route((req, res) => {
    res.json(
      deleteProject(param(req, "projectId"), actorFrom(req), {
        confirmCascade: boolQuery(req.query.confirmCascade) ?? req.body?.confirmCascade === true,
      }),
    );
  }),
);
