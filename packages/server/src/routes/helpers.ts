import type { Request } from "express";
import { badRequest, type ActorContext } from "@automation/core";

/** Builds the mutation context from the request's actor header + request id. */
export const actorFrom = (req: Request): ActorContext => ({
  actorId: req.actorId,
  source: "web",
  requestId: req.requestId,
});

/**
 * Reads a route parameter as a definite string. Express types params as an
 * index signature, so this both satisfies the compiler and turns a mis-declared
 * route into a clear 400 instead of an `undefined` reaching the query layer.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value === "") throw badRequest(`missing route parameter: ${name}`);
  return value;
}

export function boolQuery(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}
