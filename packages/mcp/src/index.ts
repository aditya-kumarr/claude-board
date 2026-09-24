#!/usr/bin/env bun
/**
 * Stdio MCP server for the board app. It talks to the same SQLite file as the
 * Express API rather than proxying HTTP, so the agent can work whether or not
 * the web server happens to be running. Every write bumps the shared revision
 * counter, which is how the open UI notices the change.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger, currentLogFile, DB_PATH, getDb } from "@automation/core";
import { initScope, type BoardScope } from "./scope.ts";
import { registerTools } from "./tools.ts";

const log = createLogger("mcp");

// Before the tools are registered, because a scoped server registers fewer of them.
// A board that does not resolve is fatal: a session whose board server refuses
// every call is worse than one that says at startup the config is stale.
let scope: BoardScope | null = null;
try {
  getDb();
  scope = initScope();
} catch (error) {
  process.stderr.write(
    `board MCP server: ${error instanceof Error ? error.message : String(error)} (AUTOMATION_BOARD=${process.env.AUTOMATION_BOARD ?? ""})\n`,
  );
  process.exit(1);
}

const server = new McpServer(
  { name: "automation-board", version: "0.1.0" },
  {
    instructions: [
      scope
        ? `This server is connected to ONE board: "${scope.boardName}" (${scope.boardId}). Every tool acts on it only — a boardId argument defaults to it, and anything on another board is refused. Start with board_get ${scope.boardId}. Cards on it are usually about the codebase this session is running in, so a card assigned to claude is work you can do right here.`
        : "",
      "This server is a time-boxed kanban board shared with the user.",
      "Every board has a duration (day/week/month/quarter/year/custom) that acts as a hard deadline: all tasks on it must finish inside that window, and tasks created without a due date inherit the board's end.",
      "Tasks carry an assignee. Tasks assigned to 'claude' are yours to actually do — call my_queue to see them, task_move them to a doing state when you start, comment progress with task_comment, and move them to a done or review state when finished.",
      "Tasks assigned to 'me' belong to the user; read them for context but do not complete them on their behalf unless asked.",
      "When the user writes @claude in a task's comment thread, that is a direct request to you: it is recorded as a tracked item, listed by the mentions tool, and it outranks work you would otherwise pick up yourself. Handle it with mention_claim -> do the work -> mention_resolve, which posts your answer back into the thread the user is reading.",
      "A board can also pull pending work out of the user's Outlook and Teams. The board app cannot reach Microsoft Graph itself, so pressing Sync only queues the request: sync_pending lists what is queued, sync_claim gives you the exact time window to read and the rules for what counts as a task, you read it with the Microsoft 365 tools and create cards with task_create (always passing sourceRef), then sync_complete advances the watermark so the next run starts where you stopped.",
      "States are per-board columns and are not fixed — beyond the defaults (To do, Doing, Blocked, Needs review, Done) you can add more with column_add.",
      scope ? "" : "Start with board_list when you do not have a board id.",
    ]
      .filter(Boolean)
      .join(" "),
  },
);

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

log.info("mcp server connected over stdio", {
  database: DB_PATH,
  scopedBoard: scope?.boardId ?? null,
  logFile: currentLogFile(),
  pid: process.pid,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("mcp server shutting down", { signal });
    void server.close().finally(() => process.exit(0));
  });
}
process.on("uncaughtException", (error) => log.error("uncaught exception", { error }));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
