import { join } from "node:path";
import { getDb } from "../db/index.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { slugify } from "../lib/ids.ts";
import { DB_PATH, REPO_ROOT } from "../lib/paths.ts";
import { getBoard } from "./boards.ts";
import { findProject } from "./projects.ts";

/**
 * Exposing ONE board to a Claude Code session that is running somewhere else —
 * typically in the codebase the board's cards are about.
 *
 * The MCP server is the same stdio server this repo's own `.mcp.json` starts,
 * started with `AUTOMATION_BOARD` set. That single variable is the whole
 * boundary: the server resolves it once at startup and from then on refuses any
 * tool call that reaches another board, and does not register the tools that
 * cannot be confined to one (creating or deleting boards, registering project
 * directories). A session in a client's repo should be able to work that
 * client's board and nothing else on this machine.
 *
 * This module holds the two facts both transports need: which board an entity
 * belongs to, and what a project has to be told to start the scoped server.
 */

/**
 * The argument names tools use for an entity, and the table that says which
 * board it is on. Every id a tool takes is one of these, which is what lets the
 * scope be one check in the MCP handler wrapper rather than fifty.
 */
const ENTITY_BOARD: Record<string, { table: string; label: string }> = {
  taskId: { table: "tasks", label: "task" },
  columnId: { table: "board_columns", label: "column" },
  mentionId: { table: "task_mentions", label: "request" },
  runId: { table: "sync_runs", label: "sync run" },
  turnId: { table: "response_turns", label: "reply change" },
  responseId: { table: "task_responses", label: "draft reply" },
  messageId: { table: "intake_messages", label: "intake message" },
  importId: { table: "whatsapp_imports", label: "WhatsApp import" },
};

export const SCOPED_ENTITY_KEYS = Object.keys(ENTITY_BOARD);

/** The board an entity id is on, or null when there is no such row (the tool reports that itself). */
export function boardIdOf(key: string, id: string): string | null {
  const entity = ENTITY_BOARD[key];
  if (!entity) return null;
  const row = getDb()
    .query<{ board_id: string }, [string]>(`SELECT board_id FROM ${entity.table} WHERE id = ?`)
    .get(id);
  return row?.board_id ?? null;
}

export const entityLabel = (key: string): string => ENTITY_BOARD[key]?.label ?? key;

/**
 * A board from whatever a person would type: its id, its exact name, or its name
 * slugified ("Lyfpath bugs" / "lyfpath_bugs"). Two boards with one name is an
 * error naming both, because silently picking one is how a session ends up
 * writing to the wrong client's board.
 */
export function resolveBoardRef(ref: string): { id: string; name: string } {
  const wanted = ref.trim();
  if (!wanted) throw badRequest("name a board: its id (brd_…) or its name");
  const rows = getDb()
    .query<{ id: string; name: string }, []>("SELECT id, name FROM boards ORDER BY datetime(created_at)")
    .all();
  const byId = rows.find((row) => row.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const slug = slugify(wanted);
  const matches = rows.filter((row) => row.name.toLowerCase() === lower || slugify(row.name) === slug);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw badRequest(`more than one board is called "${wanted}" — use its id`, {
      boards: matches.map((row) => `${row.id} (${row.name})`),
    });
  }
  throw notFound("board", wanted);
}

export interface BoardMcpConfig {
  boardId: string;
  boardName: string;
  /** Name the server is registered under in the project; tools become `mcp__<name>__…`. */
  serverName: string;
  /** The board's own project directory, when it has one — where the command is meant to be run. */
  projectPath: string | null;
  /** `claude mcp add …`, run from inside the project. Stored per user, not in the repo. */
  command: string;
  /** The same thing as a `.mcp.json` entry, for a project that wants it checked in. */
  mcpJson: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
}

const shellQuote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/**
 * What to run in a project to give its Claude Code sessions this board.
 *
 * Paths are absolute and the database is pinned, not inherited. The server is
 * started from the *project's* directory, and Bun loads `.env` from the working
 * directory — so without the pin, a project whose own `.env` happened to set
 * `AUTOMATION_DB_PATH` would open a different board file.
 */
export function boardMcpConfig(boardId: string, options: { serverName?: string } = {}): BoardMcpConfig {
  const board = getBoard(boardId);
  const serverName = slugify(options.serverName?.trim() || "board").replace(/_/g, "-");
  const entry = join(REPO_ROOT, "packages/mcp/src/index.ts");
  const env = { AUTOMATION_BOARD: board.id, AUTOMATION_DB_PATH: DB_PATH, LOG_LEVEL: "info" };
  const command = [
    "claude mcp add",
    serverName,
    ...Object.entries(env).map(([key, value]) => `-e ${key}=${shellQuote(value)}`),
    "--",
    "bun run",
    shellQuote(entry),
  ].join(" ");
  return {
    boardId: board.id,
    boardName: board.name,
    serverName,
    projectPath: findProject(board.projectId)?.path ?? null,
    command,
    mcpJson: { mcpServers: { [serverName]: { command: "bun", args: ["run", entry], env } } },
  };
}
