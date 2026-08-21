import {
  humanizeDuration,
  listComments,
  type ActivityEntry,
  type BoardColumn,
  type BoardDetail,
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

function taskLine(task: Task | TaskWithContext, options: { showBoard?: boolean } = {}): string {
  const overdue = "overdue" in task ? task.overdue : false;
  const parts = [
    `  ${PRIORITY_MARK[task.priority] ?? "  "}${task.id}  ${task.title}`,
    `assignee=${who(task.assigneeId)}`,
    `due=${shortDate(task.dueAt)}${overdue ? " OVERDUE" : ""}`,
  ];
  if (options.showBoard && "boardName" in task) parts.push(`board=${task.boardName}`);
  if (options.showBoard && "columnName" in task) parts.push(`state=${task.columnName}`);
  if (task.blockedReason) parts.push(`blocked=${task.blockedReason}`);
  return parts.join("  ");
}

export function renderBoard(detail: BoardDetail, options: { includeDone?: boolean } = {}): string {
  const { board, window, columns, tasks, stats } = detail;
  const deadline = window.expired
    ? `EXPIRED ${humanizeDuration(window.remainingMs)} ago`
    : `${humanizeDuration(window.remainingMs)} left`;

  const lines = [
    `${board.name}  (${board.id})${board.archived ? "  [archived]" : ""}`,
    `duration=${board.durationKind}  window=${window.label}  ends=${shortDate(board.endsAt)}  ${deadline}`,
    board.description ? `note: ${board.description}` : null,
    `tasks=${stats.total}  done=${stats.done}  active=${stats.active}  blocked=${stats.blocked}  review=${stats.review}  overdue=${stats.overdue}`,
    `assigned: Claude=${stats.assignedToClaude}  Me=${stats.assignedToMe}  unassigned=${stats.unassigned}`,
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
    for (const task of shown) lines.push(taskLine(task));
    if (hidden) lines.push(`  ... ${hidden} more done task(s); pass includeDone to list them`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function renderBoardSummary(detail: BoardDetail): string {
  const { board, window, stats } = detail;
  const state = window.expired ? "EXPIRED" : `${humanizeDuration(window.remainingMs)} left`;
  return (
    `${board.id}  ${board.name}  [${board.durationKind}: ${window.label}]  ${state}\n` +
    `    tasks=${stats.total} done=${stats.done} blocked=${stats.blocked} overdue=${stats.overdue}` +
    `  mine(Claude)=${stats.assignedToClaude}`
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
}): string {
  const { task, board, column, overdue } = input;
  return [
    `${task.title}  (${task.id})`,
    `board=${board.name} (${board.id})  boardDeadline=${shortDate(board.endsAt)} [${board.durationKind}]`,
    `state=${column.name} [${column.key}] (${column.kind})  priority=${task.priority}`,
    `assignee=${who(task.assigneeId)}  createdBy=${who(task.createdBy)}`,
    `due=${shortDate(task.dueAt)}${overdue ? "  OVERDUE" : ""}  completed=${task.completedAt ? shortDate(task.completedAt) : "no"}`,
    task.blockedReason ? `blockedReason=${task.blockedReason}` : null,
    "",
    task.description ? `description:\n${task.description}` : "description: (none)",
    "",
    "comments:",
    renderComments(listComments(task.id)),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
