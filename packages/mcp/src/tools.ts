import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addColumn,
  addComment,
  AppError,
  COLUMN_KINDS,
  createBoard,
  createLogger,
  createTask,
  deleteBoard,
  deleteColumn,
  deleteTask,
  DURATION_KINDS,
  getBoardDetail,
  getTaskDetail,
  listActivity,
  listBoards,
  listColumns,
  listTasks,
  moveTask,
  PRIORITIES,
  updateBoard,
  updateColumn,
  updateTask,
  USER_CLAUDE,
  type ActorContext,
} from "@automation/core";
import {
  renderActivity,
  renderBoard,
  renderBoardSummary,
  renderColumns,
  renderTaskDetail,
  renderTaskList,
} from "./format.ts";

const log = createLogger("mcp");

/** Every write from this server is attributed to Claude over the `mcp` source. */
const actor = (requestId: string): ActorContext => ({ actorId: USER_CLAUDE, source: "mcp", requestId });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

let callCounter = 0;

/**
 * Wraps a tool handler with logging and error translation. A domain error comes
 * back as tool content rather than a protocol error, so the model can read what
 * went wrong (a due date past the board deadline, an unknown column) and retry.
 */
function handler<A>(name: string, fn: (args: A, ctx: ActorContext) => string) {
  return async (args: A): Promise<ToolResult> => {
    const requestId = `mcp-${++callCounter}`;
    const startedAt = performance.now();
    const scoped = log.child({ tool: name, requestId });
    scoped.info("tool called", { args: args as Record<string, unknown> });
    try {
      const text = fn(args, actor(requestId));
      scoped.info("tool ok", { ms: Math.round(performance.now() - startedAt) });
      return ok(text);
    } catch (error) {
      const ms = Math.round(performance.now() - startedAt);
      if (error instanceof AppError) {
        scoped.warn("tool rejected", { code: error.code, message: error.message, details: error.details, ms });
        return {
          content: [
            {
              type: "text",
              text: `Error (${error.code}): ${error.message}${
                error.details ? `\ndetails: ${JSON.stringify(error.details)}` : ""
              }`,
            },
          ],
          isError: true,
        };
      }
      scoped.error("tool failed", { error, ms });
      return {
        content: [{ type: "text", text: `Unexpected error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  };
}

const durationKind = z.enum(DURATION_KINDS);
const priority = z.enum(PRIORITIES);
const columnKind = z.enum(COLUMN_KINDS);
const assignee = z
  .string()
  .describe('Who owns the task: "me" for the human, "claude" for you. Aliases "you"/"i" also work.');
const columnRef = z
  .string()
  .describe('Target state: column id, key ("needs_review") or name ("Needs review"). Case-insensitive.');

export function registerTools(server: McpServer): void {
  /* ------------------------------------------------------------------ boards */

  server.registerTool(
    "board_list",
    {
      title: "List boards",
      description:
        "List every board with its duration window, remaining time and task counts (including how many are assigned to you). Start here when you do not already know a board id.",
      inputSchema: {
        includeArchived: z.boolean().optional().describe("Include archived boards. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("board_list", (args: { includeArchived?: boolean }) => {
      const boards = listBoards({ includeArchived: args.includeArchived });
      if (boards.length === 0) return "No boards yet. Use board_create to make one.";
      return `${boards.length} board(s):\n\n${boards.map(renderBoardSummary).join("\n\n")}`;
    }),
  );

  server.registerTool(
    "board_create",
    {
      title: "Create a board",
      description:
        "Create a time-boxed board. The duration is a hard deadline: every task on the board must finish inside the window, and a task created without an explicit due date inherits the board's end. Choose day/week/month/quarter/year for the calendar period containing `anchor` (default today), or custom with an explicit endsAt.",
      inputSchema: {
        name: z.string().describe("Board name, e.g. \"Ship the MCP server\"."),
        durationKind: durationKind.describe(
          "day/week/month/quarter/year snap to the calendar period containing anchor; custom requires endsAt.",
        ),
        description: z.string().optional().describe("What this board is for."),
        anchor: z
          .string()
          .optional()
          .describe("ISO date picking which day/week/month the board covers. Defaults to today."),
        startsAt: z.string().optional().describe("Override the window start (ISO)."),
        endsAt: z.string().optional().describe("Window end (ISO). Required when durationKind is custom."),
        columns: z
          .array(z.string())
          .optional()
          .describe(
            'Custom states, left to right. Defaults to To do / Doing / Blocked / Needs review / Done. Semantic kind is inferred from each name.',
          ),
      },
    },
    handler("board_create", (args: Parameters<typeof createBoard>[0], ctx) =>
      `Board created.\n\n${renderBoard(createBoard(args, ctx))}`,
    ),
  );

  server.registerTool(
    "board_get",
    {
      title: "Get a board",
      description:
        "Full board view: duration window, time remaining, every column and the tasks in each, with ids you can pass to task_* tools. Use this before acting on a board so you move the right card into the right state.",
      inputSchema: {
        boardId: z.string().describe("Board id from board_list."),
        includeDone: z.boolean().optional().describe("List all done tasks instead of only the newest three."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("board_get", (args: { boardId: string; includeDone?: boolean }) =>
      renderBoard(getBoardDetail(args.boardId), { includeDone: args.includeDone }),
    ),
  );

  server.registerTool(
    "board_update",
    {
      title: "Update a board",
      description:
        "Rename, re-describe, archive, or change a board's duration. Shortening the window pulls any task due date back to the new deadline so the board's invariant still holds.",
      inputSchema: {
        boardId: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
        durationKind: durationKind.optional(),
        anchor: z.string().optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
        archived: z.boolean().optional().describe("Archive (true) hides the board and blocks new tasks."),
      },
    },
    handler("board_update", ({ boardId, ...patch }: { boardId: string } & Record<string, unknown>, ctx) =>
      `Board updated.\n\n${renderBoard(updateBoard(boardId, patch, ctx))}`,
    ),
  );

  server.registerTool(
    "board_delete",
    {
      title: "Delete a board",
      description:
        "Permanently delete a board with all of its columns, tasks and comments. Not reversible — prefer board_update with archived=true unless deletion was asked for explicitly.",
      inputSchema: { boardId: z.string() },
      annotations: { destructiveHint: true },
    },
    handler("board_delete", (args: { boardId: string }, ctx) => {
      const result = deleteBoard(args.boardId, ctx);
      return `Deleted board ${result.id} along with ${result.deletedTasks} task(s).`;
    }),
  );

  server.registerTool(
    "board_activity",
    {
      title: "Read board history",
      description:
        "Chronological audit trail for a board — who created, moved, edited or commented on what, and whether the change came from the web UI or from you. Use it to catch up on what the human changed since you last looked.",
      inputSchema: {
        boardId: z.string(),
        limit: z.number().int().min(1).max(200).optional().describe("Newest entries first. Default 30."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("board_activity", (args: { boardId: string; limit?: number }) =>
      renderActivity(listActivity({ boardId: args.boardId, limit: args.limit ?? 30 })),
    ),
  );

  /* ----------------------------------------------------------------- columns */

  server.registerTool(
    "column_list",
    {
      title: "List board states",
      description: "List a board's states (columns) with their keys, semantic kinds and WIP limits.",
      inputSchema: { boardId: z.string() },
      annotations: { readOnlyHint: true },
    },
    handler("column_list", (args: { boardId: string }) => renderColumns(listColumns(args.boardId))),
  );

  server.registerTool(
    "column_add",
    {
      title: "Add a state",
      description:
        "Add a new state to a board beyond the defaults — e.g. \"Waiting on Aditya\" or \"Ready to deploy\". The semantic kind is inferred from the name unless you set it; kind drives which cards count as done, blocked or in review.",
      inputSchema: {
        boardId: z.string(),
        name: z.string().describe('Display name, e.g. "Ready to deploy".'),
        kind: columnKind.optional().describe("Override the inferred semantic role."),
        position: z.number().int().min(0).optional().describe("Zero-based slot, left to right. Appended by default."),
        wipLimit: z.number().int().min(1).nullable().optional().describe("Max cards allowed in this state."),
      },
    },
    handler("column_add", ({ boardId, ...input }: { boardId: string } & Record<string, unknown>, ctx) => {
      const column = addColumn(boardId, input as { name: string }, ctx);
      return `State added: ${column.name} [${column.key}] kind=${column.kind} (${column.id})\n\n${renderColumns(listColumns(boardId))}`;
    }),
  );

  server.registerTool(
    "column_update",
    {
      title: "Update a state",
      description: "Rename a state, change its semantic kind, reorder it, or set/clear its WIP limit.",
      inputSchema: {
        boardId: z.string(),
        columnId: z.string().describe("Column id from column_list."),
        name: z.string().optional(),
        kind: columnKind.optional(),
        position: z.number().int().min(0).optional(),
        wipLimit: z.number().int().min(1).nullable().optional(),
      },
    },
    handler("column_update", ({ boardId, columnId, ...patch }: { boardId: string; columnId: string } & Record<string, unknown>, ctx) => {
      updateColumn(columnId, patch, ctx);
      return `State updated.\n\n${renderColumns(listColumns(boardId))}`;
    }),
  );

  server.registerTool(
    "column_delete",
    {
      title: "Delete a state",
      description:
        "Remove a state from a board. Its tasks are moved to another state rather than deleted — pass moveTasksTo to choose where, otherwise they land in the leftmost remaining column.",
      inputSchema: {
        boardId: z.string(),
        columnId: z.string(),
        moveTasksTo: columnRef.optional().describe("Where the orphaned tasks go."),
      },
      annotations: { destructiveHint: true },
    },
    handler("column_delete", (args: { boardId: string; columnId: string; moveTasksTo?: string }, ctx) => {
      const result = deleteColumn(args.columnId, { moveTasksTo: args.moveTasksTo }, ctx);
      return `State deleted; moved ${result.movedTasks} task(s).\n\n${renderColumns(listColumns(args.boardId))}`;
    }),
  );

  /* ------------------------------------------------------------------- tasks */

  server.registerTool(
    "task_create",
    {
      title: "Create a task",
      description:
        "Add a task to a board. Omit dueAt and it inherits the board's deadline; a dueAt after that deadline is rejected. Set assignee to \"claude\" for work you will do yourself, or \"me\" for the human.",
      inputSchema: {
        boardId: z.string(),
        title: z.string().describe("Short imperative title."),
        description: z.string().optional().describe("Detail, acceptance criteria, links."),
        column: columnRef.optional().describe("Starting state. Defaults to the leftmost column."),
        assignee: assignee.nullable().optional().describe('Defaults to unassigned.'),
        priority: priority.optional().describe("Default medium."),
        dueAt: z
          .string()
          .optional()
          .describe("ISO date/datetime inside the board window. A bare YYYY-MM-DD means end of that day."),
        blockedReason: z.string().optional().describe("Only meaningful when starting in a blocked state."),
      },
    },
    handler("task_create", ({ boardId, ...input }: { boardId: string } & Record<string, unknown>, ctx) => {
      const task = createTask(boardId, input as { title: string }, ctx);
      return renderTaskDetail(getTaskDetail(task.id));
    }),
  );

  server.registerTool(
    "task_get",
    {
      title: "Get a task",
      description:
        "Everything about one task: its board and that board's deadline, current state, assignee, due date, whether it is overdue, the full description and the comment thread. Read this before starting work assigned to you.",
      inputSchema: { taskId: z.string() },
      annotations: { readOnlyHint: true },
    },
    handler("task_get", (args: { taskId: string }) => renderTaskDetail(getTaskDetail(args.taskId))),
  );

  server.registerTool(
    "task_list",
    {
      title: "Search tasks",
      description:
        "Query tasks across every board with filters, sorted by priority then due date. Done tasks are excluded unless includeDone is set. Use my_queue instead for the simple 'what should I work on' question.",
      inputSchema: {
        boardId: z.string().optional().describe("Restrict to one board."),
        assignee: z.string().optional().describe('"me", "claude", or "none" for unassigned.'),
        column: columnRef.optional().describe("Requires boardId."),
        columnKind: columnKind.optional().describe("Filter by semantic state instead of a specific column."),
        priority: priority.optional(),
        search: z.string().optional().describe("Substring match on title and description."),
        overdueOnly: z.boolean().optional().describe("Only unfinished tasks past their due date."),
        includeDone: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler("task_list", (args: Parameters<typeof listTasks>[0]) =>
      renderTaskList(listTasks({ ...args, assignee: args?.assignee === "none" ? null : args?.assignee }), "Matching tasks"),
    ),
  );

  server.registerTool(
    "my_queue",
    {
      title: "My assigned work",
      description:
        "The work assigned to you (Claude), across all boards, most urgent first — with each task's board deadline and whether it is overdue. These are the tasks you are expected to actually do. Call this when asked what you are working on, or to pick up the next thing.",
      inputSchema: {
        boardId: z.string().optional().describe("Restrict to one board."),
        includeBlocked: z.boolean().optional().describe("Include tasks parked in a blocked state. Default true."),
        includeDone: z.boolean().optional().describe("Include finished tasks. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("my_queue", (args: { boardId?: string; includeBlocked?: boolean; includeDone?: boolean }) => {
      const tasks = listTasks({
        assignee: USER_CLAUDE,
        boardId: args.boardId,
        includeDone: args.includeDone,
      }).filter((task) => (args.includeBlocked === false ? task.columnKind !== "blocked" : true));

      const overdue = tasks.filter((task) => task.overdue).length;
      const heading = `Assigned to Claude${overdue ? ` (${overdue} OVERDUE)` : ""}`;
      const body = renderTaskList(tasks, heading);
      return tasks.length === 0
        ? `${body}\n\nNothing is assigned to you right now.`
        : `${body}\n\nNext step: task_get for detail, then task_move to "doing" when you start and "done" (or "needs review") when finished.`;
    }),
  );

  server.registerTool(
    "task_update",
    {
      title: "Update a task",
      description:
        "Edit a task's fields in place — title, description, assignee, priority, due date, blocked reason. Use task_move to change which state it sits in. Passing dueAt=null resets it to the board deadline.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        assignee: assignee.nullable().optional().describe("null unassigns."),
        priority: priority.optional(),
        dueAt: z.string().nullable().optional(),
        blockedReason: z.string().nullable().optional(),
      },
    },
    handler("task_update", ({ taskId, ...patch }: { taskId: string } & Record<string, unknown>, ctx) => {
      updateTask(taskId, patch, ctx);
      return `Task updated.\n\n${renderTaskDetail(getTaskDetail(taskId))}`;
    }),
  );

  server.registerTool(
    "task_move",
    {
      title: "Move a task to another state",
      description:
        "Move a task into a different state — this is how you show progress. Landing in a done-kind column stamps it complete; moving out of one clears that. Moving into a blocked-kind column without a blockedReason leaves the human guessing, so supply one.",
      inputSchema: {
        taskId: z.string(),
        column: columnRef,
        index: z.number().int().min(0).optional().describe("Zero-based slot within the target state. Appended by default."),
        blockedReason: z.string().nullable().optional().describe("Why it is stuck, when moving to a blocked state."),
        force: z.boolean().optional().describe("Ignore the target state's WIP limit."),
      },
    },
    handler("task_move", ({ taskId, ...input }: { taskId: string } & Record<string, unknown>, ctx) => {
      const task = moveTask(taskId, input as { column: string }, ctx);
      const detail = getTaskDetail(task.id);
      return `Moved to "${detail.column.name}"${task.completedAt ? " and marked complete" : ""}.\n\n${renderTaskDetail(detail)}`;
    }),
  );

  server.registerTool(
    "task_comment",
    {
      title: "Comment on a task",
      description:
        "Append a comment as Claude. This is the channel for reporting progress, findings, questions or hand-offs on work assigned to you — the human sees it on the card in the web UI.",
      inputSchema: {
        taskId: z.string(),
        body: z.string().describe("Comment text, up to 4000 characters."),
      },
    },
    handler("task_comment", (args: { taskId: string; body: string }, ctx) => {
      addComment(args.taskId, args.body, ctx);
      return `Comment added to ${args.taskId}.\n\n${renderTaskDetail(getTaskDetail(args.taskId))}`;
    }),
  );

  server.registerTool(
    "task_delete",
    {
      title: "Delete a task",
      description:
        "Permanently delete a task and its comments. Prefer moving it to a done or cancelled state so the history survives; only delete when the human asks.",
      inputSchema: { taskId: z.string() },
      annotations: { destructiveHint: true },
    },
    handler("task_delete", (args: { taskId: string }, ctx) => `Deleted task ${deleteTask(args.taskId, ctx).id}.`),
  );
}
