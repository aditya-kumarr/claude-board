import type { ActorSource } from "../types.ts";
import { USER_ME } from "../types.ts";

/** Who is making a change and over which transport. Threaded through every mutation. */
export interface ActorContext {
  actorId: string;
  source: ActorSource;
  /** Correlates a single HTTP request or MCP tool call across log lines. */
  requestId?: string;
}

export const webActor = (actorId: string = USER_ME, requestId?: string): ActorContext => ({
  actorId,
  source: "web",
  requestId,
});

export const systemActor = (): ActorContext => ({ actorId: "system", source: "system" });
