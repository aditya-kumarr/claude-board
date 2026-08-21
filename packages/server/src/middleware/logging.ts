import type { NextFunction, Request, Response } from "express";
import { createLogger, newRequestId, type Logger } from "@automation/core";
import { USER_ME } from "@automation/core";

const log = createLogger("http");

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Logger pre-bound to this request's id and actor. */
      log: Logger;
      requestId: string;
      /** Who the change is attributed to — `X-Actor` header, else the human. */
      actorId: string;
    }
  }
}

/** Paths logged at debug so the UI's revision poll does not flood the log file. */
const QUIET_PATHS = new Set(["/api/health", "/api/meta/revision"]);

export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.header("x-request-id") || newRequestId()).slice(0, 36);
  const actorHeader = req.header("x-actor")?.trim();
  req.requestId = requestId;
  req.actorId = actorHeader && actorHeader.length <= 40 ? actorHeader : USER_ME;
  req.log = log.child({ requestId, actor: req.actorId });
  res.setHeader("x-request-id", requestId);

  const startedAt = performance.now();
  const quiet = QUIET_PATHS.has(req.path);

  if (!quiet) {
    req.log.debug("request received", {
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body as object) : undefined,
    });
  }

  res.on("finish", () => {
    const ms = Math.round(performance.now() - startedAt);
    const context = { method: req.method, path: req.originalUrl, status: res.statusCode, ms };
    if (res.statusCode >= 500) req.log.error("request failed", context);
    else if (res.statusCode >= 400) req.log.warn("request rejected", context);
    else if (quiet) req.log.debug("request completed", context);
    else req.log.info("request completed", context);
  });

  next();
}
