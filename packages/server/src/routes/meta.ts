import { Router } from "express";
import { currentLogFile, getRevision, listUsers, logLevel, DB_PATH } from "@automation/core";
import { route } from "../middleware/errors.ts";

export const metaRouter: Router = Router();

metaRouter.get(
  "/health",
  route((_req, res) => {
    res.json({
      ok: true,
      revision: getRevision(),
      database: DB_PATH,
      logFile: currentLogFile(),
      logLevel,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

/**
 * Cheap change token. The web client polls this and only refetches boards when
 * the number moves, which is how it notices writes the MCP server made straight
 * to SQLite without going through this process.
 */
metaRouter.get(
  "/meta/revision",
  route((_req, res) => {
    res.json({ revision: getRevision() });
  }),
);

metaRouter.get(
  "/users",
  route((_req, res) => {
    res.json({ users: listUsers() });
  }),
);
