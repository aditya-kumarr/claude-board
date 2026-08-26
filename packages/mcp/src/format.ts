import {
  humanizeDuration,
  listComments,
  type ActivityEntry,
  type BoardColumn,
  type BoardDetail,
  type BoardSyncSummary,
  type MentionWithContext,
  type SyncRunWithContext,
  type Task,
  type TaskComment,
  type TaskWithContext,
} from "@automation/core";

const PRIORITY_MARK: Record<string, string> = { urgent: "!!", high: "! ", medium: "  ", low: "· " };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short local date; the time is shown only when it is not an end-of-day deadline. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
  return endOfDay ? base : `${base} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const who = (id: string | null): string =>
  id === null ? "unassigned" : id === "claude" ? "Claude" : id === "me" ? "Me" : id;

function taskLine(
  task: Task | TaskWithContext,
  options: { showBoard?: boolean; openMentions?: number } = {},
): string {
  const overdue = "overdue" in task ? task.overdue : false;
  const parts = [
    `  ${PRIORITY_MARK[task.priority] ?? "  "}${task.id}  ${task.title}`,
    `assignee=${who(task.assigneeId)}`,
    `due=${shortDate(task.dueAt)}${overdue ? " OVERDUE" : ""}`,
  ];
  if (options.openMentions) parts.push(`@claude=${options.openMentions} WAITING`);
  if (options.showBoard && "boardName" in task) parts.push(`board=${task.boardName}`);
  if (options.showBoard && "columnName" in task) parts.push(`state=${task.columnName}`);
  if (task.blockedReason) parts.push(`blocked=${task.blockedReason}`);
  return parts.join("  ");
}

export function renderBoard(detail: BoardDetail, options: { includeDone?: boolean } = {}): string {
  const { board, window, columns, tasks, stats } = detail;
  // Per-card counts, so the board view says *which* cards are waiting on a reply
  // and not just how many are.
  const waiting = new Map<string, number>();
  for (const mention of detail.openMentions) waiting.set(mention.taskId, (waiting.get(mention.taskId) ?? 0) + 1);
  const deadline = window.expired
    ? `EXPIRED ${humanizeDuration(window.remainingMs)} ago`
    : `${humanizeDuration(window.remainingMs)} left`;

  const lines = [
    `${board.name}  (${board.id})${board.archived ? "  [archived]" : ""}`,
    `duration=${board.durationKind}  window=${window.label}  ends=${shortDate(board.endsAt)}  ${deadline}`,
    board.description ? `note: ${board.description}` : null,
    `tasks=${stats.total}  done=${stats.done}  active=${stats.active}  blocked=${stats.blocked}  review=${stats.review}  overdue=${stats.overdue}`,
    `assigned: Claude=${stats.assignedToClaude}  Me=${stats.assignedToMe}  unassigned=${stats.unassigned}`,
    // Loud, because an unanswered @claude is the user waiting on a reply.
    stats.openMentions > 0
      ? `>> ${stats.openMentions} unanswered @claude request(s) in this board's comments — call mentions to read them.`
      : null,
    syncLine(detail.sync),
    "",
  ].filter((line): line is string => line !== null);

  for (const column of columns) {
    const inColumn = tasks.filter((task) => task.columnId === column.id).sort((a, b) => a.position - b.position);
    const hidden = column.kind === "done" && !options.includeDone && inColumn.length > 3 ? inColumn.length - 3 : 0;
    const shown = hidden ? inColumn.slice(0, 3) : inColumn;

    lines.push(
      `${column.name} [${column.key}] (${column.kind})  ${inColumn.length}${column.wipLimit ? `/${column.wipLimit}` : ""}`,
    );
    if (inColumn.length === 0) lines.push("  (empty)");
    for (const task of shown) lines.push(taskLine(task, { openMentions: waiting.get(task.id) }));
    if (hidden) lines.push(`  ... ${hidden} more done task(s); pass includeDone to list them`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** One line on where this board's inbox sync stands, or nothing to say. */
function syncLine(sync: BoardSyncSummary): string | null {
  if (sync.activeRun) {
    return `inbox sync: ${sync.activeRun.status} (${sync.activeRun.id}) for ${sync.activeRun.scope
      .map((entry) => entry.source)
      .join("+")} — ${sync.activeRun.status === "pending" ? "call sync_claim to run it" : "already claimed"}`;
  }
  const synced = sync.sources.filter((state) => state.syncedThrough !== null);
  if (synced.length === 0) return "inbox sync: never run for this board";
  return `inbox sync: ${synced
    .map((state) => `${state.source} through ${shortDate(state.syncedThrough)}${state.lastStatus === "failed" ? " (last run FAILED)" : ""}`)
    .join(", ")}`;
}

export function renderSyncRun(run: SyncRunWithContext): string {
  return [
    `${run.id}  [${run.status}]  board="${run.boardName}" (${run.boardId})`,
    `  scope: ${run.scope.map((entry) => `${entry.source} since ${shortDate(entry.since)}`).join(", ")}`,
    `  cutoff: ${shortDate(run.cutoff)} — becomes the new watermark only if this run succeeds`,
    `  board window: ${shortDate(run.boardStartsAt)} to ${shortDate(run.boardEndsAt)} [${run.boardDurationKind}]`,
    run.boardDescription ? `  board note: ${run.boardDescription}` : null,
    `  requested by ${who(run.requestedBy)} via ${run.actorSource} ${shortDate(run.createdAt)}`,
    run.imported ? `  imported: ${run.imported}` : null,
    run.detail ? `  detail: ${run.detail}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function renderSyncRuns(runs: SyncRunWithContext[], heading: string): string {
  if (runs.length === 0) return `${heading}\n  (nothing queued)`;
  return [`${heading}  --  ${runs.length} run(s)`, "", runs.map(renderSyncRun).join("\n\n")].join("\n");
}

export function renderSyncState(sync: BoardSyncSummary): string {
  const lines = ["inbox sync state:"];
  for (const state of sync.sources) {
    lines.push(
      `  ${state.source.padEnd(8)} synced through ${state.syncedThrough ? shortDate(state.syncedThrough) : "never"}` +
        `  lastRun=${state.lastRunAt ? shortDate(state.lastRunAt) : "—"}` +
        `  lastStatus=${state.lastStatus ?? "—"}  importedTotal=${state.imported}`,
    );
    if (state.lastDetail) lines.push(`           last detail: ${state.lastDetail}`);
  }
  if (sync.activeRun) lines.push(`  outstanding request: ${sync.activeRun.id} [${sync.activeRun.status}]`);
  return lines.join("\n");
}

export function renderBoardSummary(detail: BoardDetail): string {
  const { board, window, stats } = detail;
  const state = window.expired ? "EXPIRED" : `${humanizeDuration(window.remainingMs)} left`;
  return (
    `${board.id}  ${board.name}  [${board.durationKind}: ${window.label}]  ${state}\n` +
    `    tasks=${stats.total} done=${stats.done} blocked=${stats.blocked} overdue=${stats.overdue}` +
    `  mine(Claude)=${stats.assignedToClaude}` +
    (stats.openMentions > 0 ? `  @claude=${stats.openMentions} UNANSWERED` : "")
  );
}

export function renderTaskList(tasks: TaskWithContext[], heading: string): string {
  if (tasks.length === 0) return `${heading}\n  (nothing matches)`;
  const lines = [`${heading}  --  ${tasks.length} task(s), highest priority first`];
  for (const task of tasks) lines.push(taskLine(task, { showBoard: true }));
  return lines.join("\n");
}

export function renderComments(comments: TaskComment[]): string {
  if (comments.length === 0) return "  (no comments)";
  return comments
    .map((comment) => `  [${shortDate(comment.createdAt)}] ${who(comment.authorId)}: ${comment.body}`)
    .join("\n");
}

export function renderTaskDetail(input: {
  task: Task;
  board: { id: string; name: string; endsAt: string; durationKind: string };
  column: BoardColumn;
  overdue: boolean;
  openMentions?: MentionWithContext[];
}): string {
  const { task, board, column, overdue } = input;
  const open = input.openMentions ?? [];
  return [
    `${task.title}  (${task.id})`,
    `board=${board.name} (${board.id})  boardDeadline=${shortDate(board.endsAt)} [${board.durationKind}]`,
    `state=${column.name} [${column.key}] (${column.kind})  priority=${task.priority}`,
    `assignee=${who(task.assigneeId)}  createdBy=${who(task.createdBy)}`,
    `due=${shortDate(task.dueAt)}${overdue ? "  OVERDUE" : ""}  completed=${task.completedAt ? shortDate(task.completedAt) : "no"}`,
    task.blockedReason ? `blockedReason=${task.blockedReason}` : null,
    // Before the description, because an open request changes what to do with
    // everything below it.
    open.length > 0
      ? `\nOPEN @claude REQUEST(S) ON THIS CARD:\n${open.map(mentionRequestLine).join("\n")}`
      : null,
    "",
    task.description ? `description:\n${task.description}` : "description: (none)",
    "",
    "comments:",
    renderComments(listComments(task.id)),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const mentionRequestLine = (mention: MentionWithContext): string =>
  `  ${mention.id}  [${mention.status}]  ${mention.requestedByName} asked ${shortDate(mention.createdAt)}: ${mention.request}`;

/**
 * One request, rendered as a block rather than a line: this is the payload the
 * model acts on, so the ask, the card it hangs off and the board deadline all
 * have to be readable without a second tool call.
 */
export function renderMention(mention: MentionWithContext): string {
  return [
    `${mention.id}  [${mention.status}]  asked by ${mention.requestedByName} ${shortDate(mention.createdAt)} via ${mention.source}`,
    `  request: ${mention.request}`,
    mention.request !== mention.body.trim() ? `  full comment: ${mention.body}` : null,
    `  on task: ${mention.taskId}  "${mention.taskTitle}"`,
    `  state=${mention.columnName} [${mention.columnKey}] (${mention.columnKind})  priority=${mention.taskPriority}` +
      `  assignee=${who(mention.taskAssigneeId)}`,
    `  due=${shortDate(mention.taskDueAt)}${mention.taskOverdue ? " OVERDUE" : ""}` +
      `  board="${mention.boardName}" (${mention.boardId}) closes ${shortDate(mention.boardEndsAt)}`,
    mention.taskDescription ? `  task description: ${mention.taskDescription.replace(/\s+/g, " ").slice(0, 400)}` : null,
    mention.claimedAt ? `  claimed ${shortDate(mention.claimedAt)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function renderMentions(mentions: MentionWithContext[], heading: string): string {
  if (mentions.length === 0) return `${heading}\n  (nothing waiting)`;
  return [
    `${heading}  --  ${mentions.length} request(s), oldest first`,
    "",
    mentions.map(renderMention).join("\n\n"),
  ].join("\n");
}

export function renderActivity(entries: ActivityEntry[]): string {
  if (entries.length === 0) return "(no activity yet)";
  return entries
    .map((entry) => {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
      return `[${shortDate(entry.createdAt)}] ${who(entry.actorId)} via ${entry.source}: ${entry.action}${detail}`;
    })
    .join("\n");
}

export function renderColumns(columns: BoardColumn[]): string {
  return columns
    .map(
      (column, index) =>
        `  ${index}. ${column.name} [${column.key}] kind=${column.kind}${column.wipLimit ? ` wip=${column.wipLimit}` : ""}  ${column.id}`,
    )
    .join("\n");
}
