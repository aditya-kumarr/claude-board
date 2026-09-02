import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addColumn,
  addComment,
  AppError,
  COLUMN_KINDS,
  createBoard,
  createLogger,
  createProject,
  createTask,
  deleteBoard,
  deleteColumn,
  deleteProject,
  deleteTask,
  DURATION_KINDS,
  getBoardDetail,
  getTaskDetail,
  cancelIntakeMessage,
  cancelResponseTurn,
  cancelSyncRun,
  claimMention,
  claimIntakeMessage,
  claimResponseTurn,
  completeIntakeMessage,
  completeResponseTurn,
  claimSyncRun,
  completeSyncRun,
  draftResponse,
  getIntakeMessage,
  getResponse,
  getSyncSummary,
  getTaskResponseSummary,
  listActivity,
  listBoards,
  listColumns,
  listIntakeMessages,
  listMentions,
  listProjects,
  listResponses,
  listResponseTurns,
  listSyncRuns,
  listTasks,
  MENTION_STATUSES,
  moveTask,
  PRIORITIES,
  releaseMention,
  requestResponseDrafts,
  requireProject,
  requestSync,
  RESPONSE_CHANNELS,
  RESPONSE_STAGES,
  RESPONSE_STATUSES,
  resolveMention,
  SYNC_SOURCES,
  SYNC_SOURCE_OUTCOMES,
  type SyncSourceOutcome,
  updateBoard,
  updateColumn,
  updateProject,
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
  renderProjects,
  renderIntakeMessage,
  renderIntakeQueue,
  renderResponse,
  renderResponses,
  renderResponseTurn,
  renderResponseTurns,
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
const responseChannel = z.enum(RESPONSE_CHANNELS);
const responseStage = z.enum(RESPONSE_STAGES);
const columnRef = z
  .string()
  .describe('Target state: column id, key ("needs_review") or name ("Needs review"). Case-insensitive.');
const projectRef = z
  .string()
  .describe(
    'A registered directory: project id, slug ("nexus_web"), name, or the absolute path itself. project_list has them.',
  );

export function registerTools(server: McpServer): void {
  /* ---------------------------------------------------------------- projects */

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description:
        "List the directories on this machine that work can be carried out inside, with their paths. A board can name one as its default and a card can override it; a card's project is what decides where an @claude request on it is actually run. Call this when you need a slug to pass to board_update or task_update.",
      inputSchema: {
        includeArchived: z.boolean().optional().describe("Include archived projects. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("project_list", (args: { includeArchived?: boolean }) =>
      renderProjects(listProjects({ includeArchived: args.includeArchived })),
    ),
  );

  server.registerTool(
    "project_add",
    {
      title: "Register a project directory",
      description:
        "Register a directory as a project so cards can point at it. The path must already exist on this machine and be a directory — it is checked now rather than when a run is spawned in it. Registering the same directory twice is a conflict naming the existing project, not a second copy. The description travels in the prompt of every run delegated here, so write it for someone who has never seen the codebase.",
      inputSchema: {
        name: z.string().describe('Display name, e.g. "Nexus web".'),
        path: z
          .string()
          .describe("Absolute path to the directory, or one starting with ~. Must exist."),
        description: z
          .string()
          .optional()
          .describe("What this codebase is, and anything a run landing in it should know first."),
      },
    },
    handler("project_add", (args: { name: string; path: string; description?: string }, ctx) => {
      const project = createProject(args, ctx);
      return `Project registered: ${project.slug} → ${project.path}\n\n${renderProjects(listProjects())}`;
    }),
  );

  server.registerTool(
    "project_update",
    {
      title: "Update a project",
      description:
        "Rename a project, point it at a different directory, re-describe it, or archive it. A new path is checked the same way project_add checks one. Archiving hides it from the pickers without orphaning the cards already pointing at it.",
      inputSchema: {
        projectId: projectRef,
        name: z.string().optional().describe("Renaming also re-derives the slug."),
        path: z.string().optional(),
        description: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      },
    },
    handler("project_update", ({ projectId, ...patch }: { projectId: string } & Record<string, unknown>, ctx) => {
      const project = updateProject(requireProject(projectId).id, patch, ctx);
      return `Project updated.\n\n${renderProjects([project])}`;
    }),
  );

  server.registerTool(
    "project_delete",
    {
      title: "Unregister a project",
      description:
        "Remove a project from the board app. Nothing on disk is touched and no card is deleted: every board and card pointing at it is detached, and the counts come back so you can say what changed. Prefer project_update archived=true unless removal was asked for.",
      inputSchema: { projectId: projectRef },
      annotations: { destructiveHint: true },
    },
    handler("project_delete", (args: { projectId: string }, ctx) => {
      const project = requireProject(args.projectId);
      const result = deleteProject(project.id, ctx);
      return (
        `Unregistered "${project.name}" (${project.path}). The directory itself is untouched.\n` +
        `Detached ${result.detachedBoards} board(s) and ${result.detachedTasks} card(s), which now have no project.`
      );
    }),
  );

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
        project: projectRef
          .optional()
          .describe(
            "Directory every card on this board defaults to working in. Set it when the board is about one codebase — an @claude request on any of its cards is then carried out inside that directory.",
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
        project: projectRef
          .nullable()
          .optional()
          .describe(
            "The board's default project. null clears it; cards with their own project keep it either way.",
          ),
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
        project: projectRef
          .optional()
          .describe(
            "Directory this card's work happens in. Omit it and the card inherits its board's project, which is usually right — set it only when this card belongs to a different codebase than the rest of the board.",
          ),
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

      // Same reasoning as the mention banner: a change the user typed into a reply
      // panel is a person watching a spinner, and a queue nobody is reminded of is
      // a queue nobody checks.
      const replyTurns = listResponseTurns({ boardId: args.boardId, status: "pending", oldestFirst: true, limit: 10 });
      const replyBanner =
        replyTurns.length > 0
          ? `${renderResponseTurns(replyTurns, "QUEUED CHANGES TO DRAFT REPLIES — somebody is waiting on each of these")}\n\n` +
            `Take one with response_claim, do it, then response_complete.\n\n`
          : "";

      // A paste is somebody who handed over their raw material and is watching the
      // board for cards. Same reasoning as the two banners above it.
      const pastes = listIntakeMessages({ boardId: args.boardId, status: "pending", limit: 10 });
      const intakeBanner =
        pastes.length > 0
          ? `${renderIntakeQueue(pastes, "PASTED MATERIAL WAITING TO BECOME CARDS")}\n\n` +
            `Take one with intake_claim, make the cards, then intake_complete.\n\n`
          : "";

      const waiting = pending.length + replyTurns.length + pastes.length;
      if (tasks.length === 0) {
        return `${banner}${replyBanner}${intakeBanner}${body}\n\n${
          waiting > 0
            ? "No tasks are assigned to you, but the requests above are still waiting."
            : "Nothing is assigned to you right now."
        }`;
      }
      return (
        `${banner}${replyBanner}${intakeBanner}${body}\n\n` +
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
        project: projectRef
          .nullable()
          .optional()
          .describe(
            "Override the board's project for this card. null does not mean 'no project' — it clears the override so the card goes back to inheriting its board's.",
          ),
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
        "Claim one open request so a second run of you does not duplicate the work, and get everything needed to carry it out: the ask, the full card and its comment thread. If the card names a project, the reply carries that directory — that is the codebase the request is about, and the watcher spawns runs for these requests inside it. Claiming an already-claimed or already-resolved request fails rather than stealing it. Claim before acting, resolve when done.",
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
        force: z
          .boolean()
          .optional()
          .describe(
            "Scan a source even if it is resting. Teams is read at most every couple of hours, and rests longer after a 429, because one date-filtered chat search costs ~50 Graph calls — so a source left out of an ordinary request is deliberate. Pass this only when the user explicitly asks to check Teams right now.",
          ),
      },
    },
    handler(
      "sync_request",
      (
        args: { boardId: string; sources?: string[]; since?: string; lookbackDays?: number; force?: boolean },
        ctx,
      ) => {
        const { boardId, ...input } = args;
        const { run, alreadyQueued, skipped } = requestSync(boardId, input, ctx);
        return [
          alreadyQueued ? "A sync was already queued for this board." : "Sync queued.",
          // Never silent: a request that quietly dropped Teams looks exactly like
          // one that read it and found nothing.
          ...skipped.map(
            (entry) =>
              `Left out: ${entry.detail}. It comes back at ${entry.nextEligibleAt}` +
              `${entry.reason === "cooldown" ? "" : " — pass force to scan it now anyway"}.`,
          ),
          "",
          renderSyncRun(listSyncRuns({ boardId, limit: 50 }).find((entry) => entry.id === run.id)!),
          "",
          `Next step: sync_claim ${run.id}.`,
        ].join("\n");
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
        .map(
          (entry) =>
            `  - ${entry.source}: everything from ${entry.since} up to ${run.cutoff}` +
            (entry.cappedFrom
              ? `\n      NOTE: this window was capped. ${entry.source} is unread since ${entry.cappedFrom}, but the\n` +
                `      connector cannot return messages that old, so ${entry.since} is the honest start. Say in\n` +
                `      sync_complete that the span before it was skipped, so the user can check it themselves.`
              : ""),
        )
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
          ? "  teams:   ONE chat_message_search call, with afterDateTime and beforeDateTime set to the window\n" +
            "           above, then page it with offset/nextOffset until the results run out. That single call\n" +
            "           already covers every 1:1, group and meeting chat you are in.\n" +
            "           Do NOT call teams_list_chats to enumerate chats, and do NOT search chat by chat. This is\n" +
            "           the mistake that makes Teams syncs fail: a date-filtered chat search has no server-side\n" +
            "           endpoint behind it, so the connector answers it by walking ~50 chats itself. One call is\n" +
            "           already ~50 Graph requests, and it costs that whether the window is an hour or a week —\n" +
            "           so a second pass, or a per-chat loop, is what runs you into the rate limit. Chat ids for\n" +
            "           recipientRef come out of the search results; you do not need a separate listing.\n" +
            "           If the response is prefixed with a note that results are PARTIAL, or that it fell back\n" +
            "           to a per-chat scan, the window was not fully read — treat that exactly like a 429 below."
          : null,
        "  You have read access only. If an item needs a reply, that is a task for the user to do — never",
        "  send, forward or post anything yourself.",
        "  Microsoft Graph throttles hard (HTTP 429), Teams far sooner than mail. When you are throttled you",
        "  CANNOT WAIT IT OUT — you have no timer, no sleep and no shell, so \"I will retry shortly\" just ends",
        "  the run with the request still open, which the user sees as a failure with nothing banked. Instead",
        "  call sync_complete immediately with sourceStatus, marking the throttled source `throttled` and any",
        "  source you finished `ok`. That banks the half you read, re-reads only the half you did not, and rests",
        "  the throttled source so the user's next press does not spend a fresh budget on the same wall.",
        "  Say `throttled` rather than `failed` whenever a rate limit or a partial-results note was the reason —",
        "  `failed` alone reads as a broken connector and gets retried straight into the limit.",
        "  Reporting a whole window ok that you only half-read is the one genuinely damaging outcome.",
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
        "THEN DRAFT THE REPLY THE USER OWES (response_draft) — this is not optional:",
        "  Every card here exists because a person is waiting on the user, so a card without a reply",
        "  drafted is half a card. Right now is the ONLY moment you can write a good one: you have the",
        "  message in front of you, and after this run ends nobody will.",
        "  Per card, per person who needs an answer, write TWO drafts:",
        "    stage=acknowledge  the reply to send now — confirms receipt, says what happens next, buys",
        "                       the time the card needs. This is the one that stops a chaser mail.",
        "    stage=completion   the reply to send once the work is done — reports the outcome. The user",
        "                       sees it surface when the card reaches a done state.",
        "  Pass recipientName and recipientRef (their address, or the chat id) so a re-run cannot",
        "  duplicate a draft, and sourceRef so the user can find the original. The channel and an",
        "  email's subject are inferred from the card; a Teams reply is one to three sentences with no",
        "  greeting or sign-off, because that is what a chat message looks like.",
        "  If more than one person needs a separate answer, draft one per person — do not merge them.",
        "  Write in the user's voice, first person. Promise nothing the card does not support: no date",
        "  it does not state, no commitment it does not contain. Nothing you write is sent by anything",
        "  here — the user reads it, edits it if they want, and sends it themselves.",
        "",
        "STATES ON THIS BOARD (imported cards belong in the leftmost/backlog one unless already underway):",
        renderColumns(board.columns),
        "",
        `FINALLY: sync_complete ${run.id} with the count and a one-line summary of what you found and skipped —`,
        "and say in it whether you got the replies drafted, since that is the half the user notices missing.",
        "Complete it even when you import nothing, and complete it before you run out of room — a run left",
        "running makes the board show a sync that never ends, and there is nobody to pick up where you stopped.",
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
        sourceStatus: z
          .record(z.enum(SYNC_SOURCES), z.enum(SYNC_SOURCE_OUTCOMES))
          .optional()
          .describe(
            'Per-source outcome, for when one inbox was read fully and another was not — e.g. { "outlook": "ok", "teams": "throttled" } after Graph throttled the Teams scan. Only sources marked ok advance their watermark, so the half you read is banked and only the half you did not is re-read. Prefer this over a blanket failed whenever you got through even one source: a blanket failed throws away work you actually did. Use "throttled" rather than "failed" whenever a 429 or a partial-results note was the reason — it holds the watermark back identically and additionally rests that source for a while, which is what stops the next press running into the same limit. "failed" is for a real error: no access, a broken tool, a window you could not finish for some other reason.',
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
          sourceStatus?: Partial<Record<(typeof SYNC_SOURCES)[number], SyncSourceOutcome>>;
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

/* --------------------------------------------------------------- responses */

  server.registerTool(
    "responses",
    {
      title: "Draft replies owed",
      description:
        "The reply drafts held against cards. Every synced card exists because somebody mailed or messaged the user, so the card is only half the job — this is the other half, the message they owe back. Each draft is EMAIL or TEAMS CHAT, and has a stage: 'acknowledge' is the reply to send now, 'completion' the one to send once the work is actually done. Nothing in this system sends anything; these are words waiting for the user, and 'sent' means the user sent it themselves. Read this when asked what still needs answering.",
      inputSchema: {
        taskId: z.string().optional().describe("Only this card's replies."),
        boardId: z.string().optional().describe("Restrict to one board."),
        channel: responseChannel.optional().describe("email or chat."),
        stage: responseStage.optional(),
        status: z
          .enum(RESPONSE_STATUSES)
          .optional()
          .describe("Default is the open ones (draft + approved). 'sent' or 'discarded' to review history."),
        dueNowOnly: z
          .boolean()
          .optional()
          .describe("Only the drafts that are the user's to send right now — acknowledge replies, plus completion replies on cards that have reached a done state."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
      },
      annotations: { readOnlyHint: true },
    },
    handler(
      "responses",
      (args: {
        taskId?: string;
        boardId?: string;
        channel?: string;
        stage?: string;
        status?: string;
        dueNowOnly?: boolean;
        limit?: number;
      }) => {
        const responses = listResponses(args as Parameters<typeof listResponses>[0]);
        const body = renderResponses(responses, args.taskId ? `Replies on ${args.taskId}` : "Draft replies");
        if (responses.length === 0) {
          return `${body}\n\nNothing drafted. response_draft writes one; a card imported by a sync should have had them written at import time.`;
        }
        return (
          `${body}\n\n` +
          "To change one, the user normally types an instruction in the board's reply panel, which queues a turn — " +
          "see response_pending. You can also rewrite one directly by claiming its turn, or draft a missing one with response_draft."
        );
      },
    ),
  );

  server.registerTool(
    "response_draft",
    {
      title: "Draft a reply",
      description:
        "Write one reply the user owes on a card, ready for them to send. Call it once per person per stage: a mail that needs a holding answer now and a real answer when the work lands is TWO drafts, not one. The channel defaults to whatever the card was imported over (mail is answered with mail), and an email's subject defaults to \"Re: <card title>\". A second draft for the same person at the same stage is rejected as a conflict naming the one that exists, so a repeat pass cannot leave the user with two versions of one reply. Write in the user's voice, first person, as the person who owes the reply — not about them. You are drafting, never sending: say nothing you are not sure of, and never promise a date the card does not support.",
      inputSchema: {
        taskId: z.string().describe("The card this reply belongs to."),
        stage: responseStage.describe(
          "'acknowledge' for the reply to send now — confirms receipt, says what happens next, buys the time the card needs. 'completion' for the one to send once the work is done — reports the outcome. The completion draft is written now, while the context is in front of you, and surfaces to the user when the card reaches a done state.",
        ),
        recipientName: z.string().describe('Who it goes to, as a person: "Priya Sharma".'),
        recipientRef: z
          .string()
          .optional()
          .describe(
            "Their address or chat id. This is the slot key that stops duplicate drafts, so pass it whenever the source gives you one.",
          ),
        body: z
          .string()
          .describe(
            "The message itself, ready to send. Plain text, with the line breaks it should keep. For email include a greeting and a sign-off; for a Teams chat write one to three sentences with neither, because that is what a chat message looks like.",
          ),
        channel: responseChannel
          .optional()
          .describe("Override the inferred channel. An email carries a subject; a chat message must not."),
        subject: z
          .string()
          .optional()
          .describe('Email only, and rejected for a chat. Defaults to "Re: <card title>".'),
        cc: z.array(z.string()).optional().describe("Additional addresses. Email only."),
        sourceRef: z
          .string()
          .optional()
          .describe(
            'The message being replied to, as "<source>:<id>". Defaults to the card\'s own import key. Provenance, so the user can find the original.',
          ),
      },
    },
    handler(
      "response_draft",
      ({ taskId, ...input }: { taskId: string } & Parameters<typeof draftResponse>[1], ctx) => {
      const response = draftResponse(taskId, input, ctx);
        return `Reply drafted for the user to send.\n\n${renderResponse(getResponse(response.id))}`;
      },
    ),
  );

  server.registerTool(
    "response_pending",
    {
      title: "Queued reply changes",
      description:
        "Changes the user asked for on their draft replies, oldest first. The board app cannot ask you anything — it has no model access — so typing \"make this shorter\" into a reply panel only queues the ask, and carrying it out is your job. A 'revise' turn changes one message; a 'draft' turn asks for a card's replies to be written from scratch. Check here alongside mentions and sync_pending when catching up: somebody is watching a spinner for each of these.",
      inputSchema: {
        taskId: z.string().optional().describe("Only turns on this card."),
        boardId: z.string().optional(),
        includeFinished: z.boolean().optional().describe("Also list finished turns. Default false."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("response_pending", (args: { taskId?: string; boardId?: string; includeFinished?: boolean; limit?: number }) => {
      const turns = listResponseTurns({
        taskId: args.taskId,
        boardId: args.boardId,
        status: args.includeFinished ? undefined : ["pending", "claimed"],
        oldestFirst: !args.includeFinished,
        limit: args.limit ?? 20,
      });
      const body = renderResponseTurns(turns, args.includeFinished ? "Reply changes" : "Queued reply changes");
      if (turns.length === 0) return `${body}\n\nNothing waiting. responses lists the drafts themselves.`;
      return `${body}\n\nNext step: response_claim <turnId> — it returns the instruction and the message it applies to.`;
    }),
  );

  server.registerTool(
    "response_claim",
    {
      title: "Take a queued reply change",
      description:
        "Claim one queued change so a second run of you does not rewrite the same message twice, and get everything needed to do it: the instruction in the user's words, the current message in full, and the card it belongs to. Claim before writing; finish with response_complete.",
      inputSchema: { turnId: z.string().describe("Turn id from response_pending, e.g. rtn_a1b2c3d4.") },
    },
    handler("response_claim", (args: { turnId: string }, ctx) => {
      const turn = claimResponseTurn(args.turnId, ctx);
      const rules = [
        "",
        "HOW TO CARRY IT OUT:",
        turn.kind === "revise"
          ? "  Rewrite the WHOLE message, applying the instruction and changing nothing else. The user is\n" +
            "  iterating on words they are about to send, so an unasked-for change to a sentence they were\n" +
            "  happy with is a change they have to spot and undo. Keep their voice; keep it first person.\n" +
            "  Then call response_complete with the full new body and a one-line note saying what you changed —\n" +
            "  that note is what they read in the panel, so write it to them, not about the task."
          : "  Write the replies this card needs with response_draft — normally two per correspondent:\n" +
            "  stage=acknowledge to send now, stage=completion to send once the work is done. Read the card's\n" +
            "  description for who asked and what they asked for; that is the only provenance you have.\n" +
            "  Then call response_complete with a one-line note saying what you drafted.",
        "",
        "  You are drafting, never sending, and you cannot see the original mailbox from here — work from",
        "  the card. Do not invent facts, dates or names that are not on it; if the card does not say when",
        "  something will be done, write a reply that does not promise a date.",
        `  Finish with response_complete ${turn.id}. A turn left claimed shows the user a change that never`,
        "  arrives, which is worse than one that failed with a reason.",
      ].join("\n");
      return `Claimed ${turn.id}.\n\n${renderResponseTurn(turn)}\n${rules}`;
    }),
  );

  server.registerTool(
    "response_complete",
    {
      title: "Close out a reply change",
      description:
        "Finish a claimed turn. For a 'revise' this is also how the new message lands: pass the full rewritten body and it replaces the draft in the same transaction, so the thread and the text can never disagree. `note` is your side of the conversation — one line the user reads under their instruction. Use status=failed when you could not do what was asked, with the reason in the note: the draft then keeps its old text and the user can see why, which silence does not give them.",
      inputSchema: {
        turnId: z.string(),
        note: z
          .string()
          .describe(
            "One line to the user: what you changed, or why you could not. Shown in the reply panel under their instruction.",
          ),
        body: z
          .string()
          .optional()
          .describe(
            "The complete rewritten message. Required to finish a 'revise' successfully — a partial or omitted body would leave the draft as it was while the thread claimed it changed. Not used by a 'draft' turn, which creates messages with response_draft.",
          ),
        subject: z
          .string()
          .optional()
          .describe("New subject, when the instruction changed it. Email only."),
        status: z
          .enum(["done", "failed"])
          .optional()
          .describe("Default done. Use failed when the instruction could not be carried out."),
      },
    },
    handler(
      "response_complete",
      (args: { turnId: string; note: string; body?: string; subject?: string; status?: "done" | "failed" }, ctx) => {
        const { turnId, ...input } = args;
        const turn = completeResponseTurn(turnId, input, ctx);
        if (turn.response) {
          return `Turn ${turn.id} marked ${turn.status}.\n\n${renderResponse(getResponse(turn.response.id))}`;
        }
        return (
          `Turn ${turn.id} marked ${turn.status}.\n\n` +
          renderResponses(listResponses({ taskId: turn.taskId, status: RESPONSE_STATUSES }), `Replies on ${turn.taskId}`)
        );
      },
    ),
  );

  server.registerTool(
    "response_request",
    {
      title: "Queue a reply-drafting pass",
      description:
        "Ask for a card's replies to be drafted, as the board's \"Draft replies\" button does. Use it for a card that has none — one typed in by hand, or one whose drafts were discarded — when you are not going to write them yourself in this session. If you are already looking at the card, response_draft is more direct. Asking twice does not stack: an outstanding request is returned as-is.",
      inputSchema: {
        taskId: z.string(),
        instruction: z
          .string()
          .optional()
          .describe("What the drafts should cover, if anything beyond the default acknowledge + completion pair."),
      },
    },
    handler("response_request", (args: { taskId: string; instruction?: string }, ctx) => {
      const { turn, alreadyQueued } = requestResponseDrafts(args.taskId, args.instruction, ctx);
      return (
        `${alreadyQueued ? "A drafting pass was already queued for this card." : "Drafting pass queued."}\n\n` +
        `${renderResponseTurn(turn)}\n\nNext step: response_claim ${turn.id}.`
      );
    }),
  );

  server.registerTool(
    "response_cancel",
    {
      title: "Abandon a queued reply change",
      description:
        "Drop a queued or claimed turn without changing the draft — for a request that is no longer wanted, or one left claimed by a dead run. Prefer response_complete with status=failed when you tried and could not do it, so the reason reaches the user.",
      inputSchema: { turnId: z.string(), reason: z.string().describe("Why it is being abandoned.") },
      annotations: { destructiveHint: true },
    },
    handler("response_cancel", (args: { turnId: string; reason: string }, ctx) => {
      const turn = cancelResponseTurn(args.turnId, args.reason, ctx);
      return `Turn ${turn.id} cancelled. The draft is unchanged.`;
    }),
  );

/* ------------------------------------------------------------------ intake */

  server.registerTool(
    "intake_pending",
    {
      title: "Pasted material waiting to become cards",
      description:
        "Each board has a chat the user pastes raw material into — a CSV export, notes from a call, a forwarded thread, a screenshot of a whiteboard — and this is what is waiting to be turned into cards. The board app cannot read any of it into tasks itself; it has no model access, so pasting is all it can do and the rest is your job. Check here alongside mentions, sync_pending and response_pending when catching up: each of these is a person who pasted something and is watching for cards to appear.",
      inputSchema: {
        boardId: z.string().optional().describe("Restrict to one board."),
        includeFinished: z.boolean().optional().describe("Also list messages already handled. Default false."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    handler("intake_pending", (args: { boardId?: string; includeFinished?: boolean; limit?: number }) => {
      const messages = listIntakeMessages({
        boardId: args.boardId,
        status: args.includeFinished ? undefined : ["pending", "claimed"],
        limit: args.limit ?? 20,
      });
      const body = renderIntakeQueue(messages, args.includeFinished ? "Intake messages" : "Pasted, waiting to be read");
      if (messages.length === 0) return `${body}\n\nNothing waiting.`;
      return `${body}\n\nNext step: intake_claim <messageId> — it returns the material in full plus the board's states.`;
    }),
  );

  server.registerTool(
    "intake_claim",
    {
      title: "Take a pasted message and read it",
      description:
        "Claim one pasted message so a second run of you does not create the same cards twice, and get everything needed to act: what the user typed, the pasted text in full, the contents of any text file they attached, the on-disk path of any screenshot or PDF to open with Read, the board's states, and the board's deadline. Claim before creating anything; finish with intake_complete.",
      inputSchema: { messageId: z.string().describe("Message id from intake_pending, e.g. itk_a1b2c3d4.") },
    },
    handler("intake_claim", (args: { messageId: string }, ctx) => {
      const message = claimIntakeMessage(args.messageId, ctx);
      const board = getBoardDetail(message.boardId);
      const existing = listTasks({ boardId: message.boardId, includeDone: true, limit: 500 });

      return [
        `Claimed ${message.id}.`,
        "",
        renderIntakeMessage(message),
        "",
        message.readablePaths.length > 0
          ? "FILES TO OPEN — use Read on each path above. A screenshot is often the only place the real\n" +
            "  detail lives, so read it before deciding what the cards are. If Read is not available to you,\n" +
            "  say so in intake_complete rather than guessing at what the image said."
          : "Everything the user gave you is inline above. There are no files to open.",
        "",
        "WHAT TO MAKE OF IT:",
        "  Follow what they typed. It usually says the shape they want — one card per row, one per",
        "  action item, only the open ones — and that instruction beats your own reading of the data.",
        "  When they typed nothing, infer the obvious: a CSV of work becomes a card per row; notes from",
        "  a call become a card per action item; a screenshot of a plan becomes a card per box on it.",
        "",
        "  A row is not automatically a task. Skip headers, totals, blank rows, and anything the data",
        "  itself marks as already finished or cancelled — and say in your reply that you skipped it, so",
        "  they can disagree. Making 40 cards from a 40-row export that included 12 done rows is worse",
        "  than making 28 and saying why.",
        "",
        "  Map columns onto the card rather than dumping them in the title. An owner column is the",
        "  assignee (\"me\" for the user, \"claude\" for you — only for work you can actually do). A date",
        `  column is dueAt, and it must fall inside the board window (ends ${message.boardEndsAt}); a date`,
        "  outside it is rejected, so leave it out and note that it fell outside rather than silently",
        "  moving their deadline. A priority or severity column maps onto priority. Anything left over",
        "  goes in the description, along with where the row came from — that provenance is the only",
        "  record of what produced this card.",
        "",
        "  Do NOT invent work that was not in the material. If it is ambiguous, make the cards you are",
        "  sure of and name the ambiguity in your reply: you are unattended and there is nobody to ask.",
        "",
        "  Duplicates: this board already has the cards listed below. If the paste covers work that is",
        "  already there, update or skip rather than adding a second card for it, and say which.",
        "",
        "STATES ON THIS BOARD (new cards belong in the leftmost/backlog one unless the data says otherwise):",
        renderColumns(board.columns),
        "",
        existing.length > 0
          ? `ALREADY ON THIS BOARD (${existing.length}) — check against these before creating:\n${renderTaskList(existing, "existing cards")}`
          : "This board has no cards yet, so nothing can be a duplicate.",
        "",
        `FINALLY: intake_complete ${message.id} with the ids you created and a reply written to the user —`,
        "what you made, what you skipped and why. That text is the message they see in the chat, so it is",
        "the only account they get of your judgement. Complete it even if you create nothing; a message",
        "left claimed shows them a paste that is still being read forever.",
      ].join("\n");
    }),
  );

  server.registerTool(
    "intake_complete",
    {
      title: "Reply in the intake chat",
      description:
        "Finish a claimed message. `createdTasks` are the ids task_create returned, and they are checked against the board — the chat renders them as links, so a reply naming cards that are not there reads as work having been done when it was not. `note` is your reply in the conversation: say what you made, what you skipped and why, and name anything you were unsure about. Use status=failed when you could not use the material at all, with the reason — a paste that produces silence is the one outcome the user cannot act on.",
      inputSchema: {
        messageId: z.string(),
        note: z
          .string()
          .describe(
            "Your reply, written to the user. What you made, what you deliberately left out, and anything they should decide themselves.",
          ),
        createdTasks: z
          .array(z.string())
          .optional()
          .describe("Ids of the cards you created for this message, exactly as task_create returned them."),
        status: z
          .enum(["done", "failed"])
          .optional()
          .describe("Default done. Use failed when the material could not be used, with the reason in the note."),
      },
    },
    handler(
      "intake_complete",
      (args: { messageId: string; note: string; createdTasks?: string[]; status?: "done" | "failed" }, ctx) => {
        const { messageId, ...input } = args;
        const message = completeIntakeMessage(messageId, input, ctx);
        return (
          `Replied in the intake chat; message ${message.id} marked ${message.status}.\n\n` +
          renderBoard(getBoardDetail(message.boardId))
        );
      },
    ),
  );

  server.registerTool(
    "intake_cancel",
    {
      title: "Abandon a pasted message",
      description:
        "Drop a queued or claimed intake message without creating anything — for material that is no longer wanted, or one left claimed by a dead process. Prefer intake_complete with status=failed when you looked at it and could not use it, so the reason reaches the user.",
      inputSchema: { messageId: z.string(), reason: z.string().describe("Why it is being abandoned.") },
      annotations: { destructiveHint: true },
    },
    handler("intake_cancel", (args: { messageId: string; reason: string }, ctx) => {
      const message = cancelIntakeMessage(args.messageId, args.reason, ctx);
      return `Intake message ${message.id} cancelled. Nothing was created.`;
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
