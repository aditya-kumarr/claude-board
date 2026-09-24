import { badRequest, boardIdOf, entityLabel, resolveBoardRef, SCOPED_ENTITY_KEYS } from "@automation/core";

/**
 * Confining this server to one board, for a Claude Code session running in some
 * other project (see `services/connect.ts` for why and how it is started).
 *
 * Unset, nothing here does anything and the server sees every board, which is
 * what this repo's own `.mcp.json` and the watchers want. Set, it is enforced in
 * two places and nowhere else:
 *
 *   - `SCOPED_OUT` tools are not registered at all. They are the ones that cannot
 *     be confined to a board — making or deleting boards, and registering the
 *     project directories an unattended run is later given write access to — so
 *     a session in one client's repo cannot see they exist.
 *   - Every other call goes through `applyScope` in the handler wrapper. A
 *     missing `boardId` is filled in with the scoped one, a different one is
 *     refused, and every entity id an argument names (a task, a request, an
 *     import …) is looked up and refused if it lives on another board.
 *
 * The error names the scoped board rather than just saying no, so the model
 * corrects itself instead of retrying the same call.
 */

export interface BoardScope {
  boardId: string;
  boardName: string;
}

/** Tools that act across boards or on the machine, and so do not exist in a scoped server. */
export const SCOPED_OUT = new Set([
  "board_create",
  "board_delete",
  "project_list",
  "project_add",
  "project_update",
  "project_delete",
  "project_usage_check",
]);

/** `--board <ref>` wins over `AUTOMATION_BOARD`, so a one-off launch can override a config. */
function requestedBoard(): string | undefined {
  const flag = process.argv.indexOf("--board");
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  return process.env.AUTOMATION_BOARD?.trim() || undefined;
}

let scope: BoardScope | null = null;

/**
 * Resolves the scope once, at startup. Throws on a board that does not exist, so
 * a stale config fails loudly when the session starts rather than serving a
 * server that refuses every call.
 */
export function initScope(): BoardScope | null {
  const ref = requestedBoard();
  if (!ref) return null;
  const board = resolveBoardRef(ref);
  scope = { boardId: board.id, boardName: board.name };
  return scope;
}

export const currentScope = (): BoardScope | null => scope;

const outOfScope = (what: string) =>
  badRequest(
    `${what} — this server is connected only to "${scope!.boardName}" (${scope!.boardId}). Work on that board, or ask the user to connect the other one.`,
    { scopedBoard: scope!.boardId },
  );

/**
 * Checks, and where it can fills in, a tool call's arguments. Returns the args to use.
 *
 * `takesBoardId` says whether the tool's schema declares `boardId`. Filling it in
 * for a tool that does not would be a bug rather than a no-op: several handlers
 * spread their remaining arguments straight into a core update.
 */
export function applyScope<A>(args: A, takesBoardId: boolean): A {
  if (!scope || args === null || typeof args !== "object") return args;
  const record = { ...(args as Record<string, unknown>) };

  if (!takesBoardId) {
    // Nothing to fill; a stray boardId cannot reach a tool whose schema lacks it.
  } else if (record.boardId === undefined || record.boardId === null || record.boardId === "") {
    record.boardId = scope.boardId;
  } else if (record.boardId !== scope.boardId) {
    // A name works too, as long as it names this board.
    let resolved: string | null = null;
    try {
      resolved = resolveBoardRef(String(record.boardId)).id;
    } catch {
      resolved = null;
    }
    if (resolved !== scope.boardId) throw outOfScope(`board "${String(record.boardId)}" is a different board`);
    record.boardId = scope.boardId;
  }

  for (const key of SCOPED_ENTITY_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    const boardId = boardIdOf(key, value);
    // An unknown id is left to the tool, which says "not found" better than this can.
    if (boardId !== null && boardId !== scope.boardId) throw outOfScope(`${entityLabel(key)} ${value} is on another board`);
  }
  return record as A;
}
