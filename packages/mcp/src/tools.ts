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
  cancelSyncRun,
  claimMention,
  claimSyncRun,
  completeSyncRun,
  getSyncSummary,
  listActivity,
  listBoards,
  listColumns,
  listMentions,
  listSyncRuns,
  listTasks,
  MENTION_STATUSES,
  moveTask,
  PRIORITIES,
  releaseMention,
  requestSync,
  resolveMention,
  SYNC_SOURCES,
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
  renderMention,
  renderMentions,
  renderSyncRun,
  renderSyncRuns,
  renderSyncState,
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
        sourceRef: z
          .string()
          .optional()
          .describe(
            'Import key when this card comes from somewhere else, as "<source>:<stable id>" — e.g. "outlook:<message id>" or "teams:<message id>". Unique per board: a conflict naming an existingTaskId means you already imported that item, so skip it rather than making a second card. Always set this when importing during a sync.',
          ),
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
        sourceRef: z.string().optional().describe("Exact import key, to check whether an item is already on a board."),
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

      // An unanswered @claude outranks the queue: the human is waiting on a reply,
      // and it is the one thing here with a person on the other end of it.
      const pending = listMentions({ boardId: args.boardId, status: "pending" });
      const banner =
        pending.length > 0
          ? `${renderMentions(pending, "UNANSWERED @claude REQUESTS — handle these first")}\n\n` +
            `Take one with mention_claim, do it, then mention_resolve.\n\n`
          : "";

      if (tasks.length === 0) {
        return `${banner}${body}\n\n${
          pending.length > 0
            ? "No tasks are assigned to you, but the requests above are still waiting."
            : "Nothing is assigned to you right now."
        }`;
      }
      return (
        `${banner}${body}\n\n` +
        `Next step: task_get for detail, then task_move to "doing" when you start and "done" (or "needs review") when finished.`
      );
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
        "Append a comment as Claude. This is the channel for reporting progress, findings, questions or hand-offs on work assigned to you — the human sees it on the card in the web UI. Note that when the *human* writes @claude in a comment it becomes a tracked request you are expected to act on (see the mentions tool); your own comments never create one.",
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

  /* ---------------------------------------------------------------- mentions */

  server.registerTool(
    "mentions",
    {
      title: "Requests addressed to me",
      description:
        "Your inbox. When the human writes @claude in a task's comment thread it becomes a tracked request, and this lists the ones still open — oldest first, each with the ask itself plus the card, its state, its due date and the board deadline, so one call is enough to act. These are direct asks from a person and take precedence over picking up queue work on your own initiative. Read here first whenever you are catching up.",
      inputSchema: {
        boardId: z.string().optional().describe("Restrict to one board."),
        status: z
          .enum(MENTION_STATUSES)
          .optional()
          .describe(
            "Default is the open ones (pending + claimed). 'answered' or 'dismissed' to review what you already handled.",
          ),
        taskId: z.string().optional().describe("Only requests on this card."),
        since: z.string().optional().describe("ISO timestamp; only requests made after it."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    handler(
      "mentions",
      (args: { boardId?: string; status?: (typeof MENTION_STATUSES)[number]; taskId?: string; since?: string; limit?: number }) => {
        const mentions = listMentions(args);
        const heading = args.status ? `@claude requests [${args.status}]` : "Open @claude requests";
        const body = renderMentions(mentions, heading);
        if (mentions.length === 0) return `${body}\n\nNothing is waiting on you. my_queue has the work assigned to you.`;
        return (
          `${body}\n\n` +
          `Next step: mention_claim <mentionId> to take one (it returns the card and the whole thread), ` +
          `do what was asked with the task_* tools, then mention_resolve with a one-line summary of what you did.`
        );
      },
    ),
  );

  server.registerTool(
    "mention_claim",
    {
      title: "Take a request",
      description:
        "Claim one open request so a second run of you does not duplicate the work, and get everything needed to carry it out: the ask, the full card and its comment thread. Claiming an already-claimed or already-resolved request fails rather than stealing it. Claim before acting, resolve when done.",
      inputSchema: {
        mentionId: z.string().describe("Request id from the mentions tool, e.g. men_a1b2c3d4."),
      },
    },
    handler("mention_claim", (args: { mentionId: string }, ctx) => {
      const mention = claimMention(args.mentionId, ctx);
      return [
        `Claimed ${mention.id}.`,
        "",
        renderMention(mention),
        "",
        "--- the card in full ---",
        "",
        renderTaskDetail(getTaskDetail(mention.taskId)),
        "",
        `Do what was asked, then call mention_resolve for ${mention.id}. If you cannot, resolve it as dismissed and say why — leaving it claimed reads to the human as ignored.`,
      ].join("\n");
    }),
  );

  server.registerTool(
    "mention_resolve",
    {
      title: "Close out a request",
      description:
        "Close a request you have finished. `resolution` is the one-line record of what you actually did. By default that same text is posted into the task's comment thread as your reply, because a request answered with silence in the thread is indistinguishable from one that was ignored — pass an explicit `reply` for a longer answer, or reply=null to resolve without commenting. Use status=dismissed when the right outcome was to not act, and say why.",
      inputSchema: {
        mentionId: z.string(),
        resolution: z
          .string()
          .describe("What you did about it, one line, up to 1000 characters. Recorded in the audit trail."),
        status: z
          .enum(["answered", "dismissed"])
          .optional()
          .describe("Default answered. Use dismissed when you deliberately did not act, with the reason in resolution."),
        reply: z
          .string()
          .nullable()
          .optional()
          .describe("Comment posted back into the thread. Defaults to the resolution text; null posts nothing."),
      },
    },
    handler(
      "mention_resolve",
      (
        args: { mentionId: string; resolution: string; status?: "answered" | "dismissed"; reply?: string | null },
        ctx,
      ) => {
        const { mentionId, ...input } = args;
        const mention = resolveMention(mentionId, input, ctx);
        return `Request ${mention.id} marked ${mention.status}.\n\n${renderTaskDetail(getTaskDetail(mention.taskId))}`;
      },
    ),
  );

  server.registerTool(
    "mention_release",
    {
      title: "Put a request back",
      description:
        "Return a request you claimed to the pending queue, for when you cannot finish it now and want it picked up later rather than resolved. Prefer mention_resolve with status=dismissed when the answer is that it should not be done at all.",
      inputSchema: {
        mentionId: z.string(),
        reason: z.string().describe("Why you are handing it back."),
      },
    },
    handler("mention_release", (args: { mentionId: string; reason: string }, ctx) => {
      const mention = releaseMention(args.mentionId, args.reason, ctx);
      return `Request ${mention.id} is pending again.\n\n${renderMention(mention)}`;
    }),
  );

  /* -------------------------------------------------------------- inbox sync */

  server.registerTool(
    "sync_state",
    {
      title: "Inbox sync watermarks",
      description:
        "Where a board's Outlook/Teams sync has got to: how far each source has been read, when it last ran, and whether a request is outstanding. The watermark is the contract — the next run reads from it, so never re-scan from further back without a reason.",
      inputSchema: { boardId: z.string() },
      annotations: { readOnlyHint: true },
    },
    handler("sync_state", (args: { boardId: string }) => renderSyncState(getSyncSummary(args.boardId))),
  );

  server.registerTool(
    "sync_pending",
    {
      title: "Queued inbox syncs",
      description:
        "Sync requests waiting to be run, oldest first. The board app cannot reach Microsoft Graph itself, so pressing Sync only queues the work — this is where it lands, and running it is your job. Check here alongside mentions when catching up.",
      inputSchema: {
        boardId: z.string().optional().describe("Restrict to one board."),
        includeFinished: z.boolean().optional().describe("Also list completed runs. Default false."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("sync_pending", (args: { boardId?: string; includeFinished?: boolean; limit?: number }) => {
      const runs = listSyncRuns({
        boardId: args.boardId,
        status: args.includeFinished ? undefined : ["pending", "running"],
        oldestFirst: !args.includeFinished,
        limit: args.limit,
      });
      const body = renderSyncRuns(runs, args.includeFinished ? "Sync runs" : "Queued syncs");
      if (runs.length === 0) return `${body}\n\nNothing to sync. sync_request queues one if the user asks.`;
      return `${body}\n\nNext step: sync_claim <runId> — it returns the window to read and the rules for what becomes a task.`;
    }),
  );

  server.registerTool(
    "sync_request",
    {
      title: "Queue an inbox sync",
      description:
        "Queue a sync for a board, as the Sync button does. Use this when the user asks you to check their mail or Teams for a board rather than pressing the button themselves; then sync_claim it and carry it out. Pressing twice does not stack: an outstanding request is returned as-is.",
      inputSchema: {
        boardId: z.string(),
        sources: z
          .array(z.enum(SYNC_SOURCES))
          .optional()
          .describe("Which inboxes to read. Defaults to both outlook and teams."),
        since: z
          .string()
          .optional()
          .describe("Override the stored watermark for this run only (ISO). Omit to continue where the last run stopped."),
        lookbackDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("How far back to look when this board has never synced. Default 14."),
      },
    },
    handler(
      "sync_request",
      (args: { boardId: string; sources?: string[]; since?: string; lookbackDays?: number }, ctx) => {
        const { boardId, ...input } = args;
        const { run, alreadyQueued } = requestSync(boardId, input, ctx);
        return (
          `${alreadyQueued ? "A sync was already queued for this board." : "Sync queued."}\n\n` +
          `${renderSyncRun(listSyncRuns({ boardId, limit: 50 }).find((entry) => entry.id === run.id)!)}\n\n` +
          `Next step: sync_claim ${run.id}.`
        );
      },
    ),
  );

  server.registerTool(
    "sync_claim",
    {
      title: "Run a queued inbox sync",
      description:
        "Take a queued sync and get everything needed to run it: the exact time window per source, the board's states, and the rules for what should become a task. You do the reading with the Microsoft 365 tools and the writing with task_create, then close it out with sync_complete. Claim before reading so a second run does not import the same mail twice.",
      inputSchema: { runId: z.string().describe("Run id from sync_pending, e.g. syn_a1b2c3d4.") },
    },
    handler("sync_claim", (args: { runId: string }, ctx) => {
      const run = claimSyncRun(args.runId, ctx);
      const board = getBoardDetail(run.boardId);
      const windows = run.scope
        .map((entry) => `  - ${entry.source}: everything from ${entry.since} up to ${run.cutoff}`)
        .join("\n");

      return [
        `Claimed ${run.id}.`,
        "",
        renderSyncRun(run),
        "",
        "WINDOW TO READ (do not read outside it — the watermark exists so you do not re-read old mail):",
        windows,
        "",
        "HOW TO READ IT — with whichever Microsoft 365 tools you have; names vary by connector:",
        run.scope.some((entry) => entry.source === "outlook")
          ? "  outlook: a mail search restricted to the window (e.g. outlook_email_search with a received range,\n" +
            "           or list-mail-messages with a receivedDateTime filter). Open a message body only when the\n" +
            "           subject and sender are not enough to judge whether it is a task."
          : null,
        run.scope.some((entry) => entry.source === "teams")
          ? "  teams:   list your chats, then search messages within the window (e.g. teams_list_chats plus\n" +
            "           chat_message_search, or list-chats plus list-chat-messages)."
          : null,
        "  You have read access only. If an item needs a reply, that is a task for the user to do — never",
        "  send, forward or post anything yourself.",
        "  Microsoft Graph throttles hard (HTTP 429 with a retryAfterSeconds). Page through results rather",
        "  than issuing many small searches, wait out a 429 once, and if you are still throttled after that,",
        "  stop and sync_complete with status=failed — the watermark stays put, so retrying later loses",
        "  nothing. Half-reading the window and reporting ok is the one genuinely damaging outcome.",
        "",
        "WHAT BECOMES A TASK — a thing the user still owes someone:",
        "  yes: a direct ask or assignment, a question awaiting their answer, a commitment they made,",
        "       an approval or review waiting on them, a deadline they were given.",
        "  no:  newsletters, automated notifications, calendar noise, CC-for-information, marketing,",
        "       anything already done, and anything that is only a reply to something they said.",
        "  When it is genuinely ambiguous, skip it and say so in sync_complete. A board full of",
        "  non-tasks is worse than a board missing one.",
        "",
        "HOW TO CREATE EACH ONE (task_create):",
        `  boardId    ${run.boardId}`,
        `  sourceRef  REQUIRED. "outlook:<message id>" or "teams:<message id>" — a conflict naming an`,
        "             existingTaskId means it was already imported, so skip it and keep going.",
        "  title      short and imperative, what the user has to do — not the subject line verbatim.",
        "  description who asked, when, where it came from, and the ask in their words. This is the only",
        "             provenance the card will ever have, so include enough to act without reopening the mail.",
        '  assignee   "me" — this is the user\'s inbox, so the work is theirs unless the mail says otherwise.',
        "  dueAt      only when the source states or clearly implies one, and it must fall inside the board",
        `             window (ends ${run.boardEndsAt}). Omit it to inherit the board deadline.`,
        "  priority   from the ask, not from the sender's tone. Default medium.",
        "",
        "STATES ON THIS BOARD (imported cards belong in the leftmost/backlog one unless already underway):",
        renderColumns(board.columns),
        "",
        `FINALLY: sync_complete ${run.id} with the count and a one-line summary of what you found and skipped.`,
        "Complete it even when you import nothing — a run left running makes the board show a sync that never ends.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    }),
  );

  server.registerTool(
    "sync_complete",
    {
      title: "Close out an inbox sync",
      description:
        "Finish a claimed sync. On status=ok the window you just read becomes the board's new watermark, so the next run starts where this one stopped — only report ok if you actually read the whole window. On status=failed the watermark stays put and the window is re-read next time, which is the right outcome when Graph errored or you could not finish. `detail` is what the user sees as the result, so say what you imported and what you skipped.",
      inputSchema: {
        runId: z.string(),
        imported: z
          .record(z.enum(SYNC_SOURCES), z.number().int().min(0))
          .optional()
          .describe(
            'Tasks created, per source — e.g. { "outlook": 2, "teams": 0 }. Name every source the run scanned; a total spread across both would credit Teams for Outlook mail.',
          ),
        detail: z
          .string()
          .describe(
            "One or two lines the user will read: what you brought in, what you deliberately skipped, and anything they should look at themselves.",
          ),
        status: z
          .enum(["ok", "failed"])
          .optional()
          .describe("Default ok. Use failed if you could not read the whole window — it keeps the watermark unmoved."),
      },
    },
    handler(
      "sync_complete",
      (
        args: {
          runId: string;
          imported?: Partial<Record<(typeof SYNC_SOURCES)[number], number>>;
          detail: string;
          status?: "ok" | "failed";
        },
        ctx,
      ) => {
        const { runId, ...input } = args;
        const run = completeSyncRun(runId, input, ctx);
        return (
          `Sync ${run.id} marked ${run.status}. ${
            run.status === "ok"
              ? `Watermark advanced to ${run.cutoff}.`
              : "Watermark left where it was; the next run re-reads this window."
          }\n\n${renderSyncState(getSyncSummary(run.boardId))}`
        );
      },
    ),
  );

  server.registerTool(
    "sync_cancel",
    {
      title: "Abandon an inbox sync",
      description:
        "Drop a queued or running sync without moving the watermark — for a request that is no longer wanted, or one left running by a dead process. Prefer sync_complete with status=failed when you tried and could not finish, so the reason lands on the board.",
      inputSchema: { runId: z.string(), reason: z.string().describe("Why it is being abandoned.") },
      annotations: { destructiveHint: true },
    },
    handler("sync_cancel", (args: { runId: string; reason: string }, ctx) => {
      const run = cancelSyncRun(args.runId, args.reason, ctx);
      return `Sync ${run.id} cancelled. Watermark unchanged.`;
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
