import type { NextFunction, Request, Response } from "express";
import { AppError, createLogger } from "@automation/core";

const log = createLogger("http");

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: `no route for ${req.method} ${req.path}` } });
}

/**
 * Single exit point for failures: domain `AppError`s keep their status and code,
 * anything else is logged with a stack and reported as a generic 500.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const logger = req.log ?? log;

  if (error instanceof AppError) {
    logger.warn("request error", {
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
      path: req.originalUrl,
    });
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }

  logger.error("unhandled error", { path: req.originalUrl, method: req.method, error });
  res.status(500).json({ error: { code: "internal_error", message: "something went wrong on the server" } });
}

/** Wraps a route so a thrown or rejected error reaches `errorHandler`. */
export function route<T>(handler: (req: Request, res: Response) => T | Promise<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      Promise.resolve(handler(req, res)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}
