import {
  humanizeDuration,
  listComments,
  projectPathExists,
  type ActivityEntry,
  type BoardColumn,
  type BoardDetail,
  type BoardSyncSummary,
  type IntakeAttachment,
  type IntakeMessageWithContext,
  type IntakeMessageWithFiles,
  type MentionWithContext,
  type Project,
  type ResolvedProject,
  type ResponseTurn,
  type ResponseTurnWithContext,
  type ResponseWithContext,
  type TaskResponseSummary,
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
  options: { showBoard?: boolean; openMentions?: number; replies?: { open: number; dueNow: number } } = {},
): string {
  const overdue = "overdue" in task ? task.overdue : false;
  const parts = [
    `  ${PRIORITY_MARK[task.priority] ?? "  "}${task.id}  ${task.title}`,
    `assignee=${who(task.assigneeId)}`,
    `due=${shortDate(task.dueAt)}${overdue ? " OVERDUE" : ""}`,
  ];
  if (options.openMentions) parts.push(`@claude=${options.openMentions} WAITING`);
  if (options.replies?.open) {
    parts.push(`replies=${options.replies.open}${options.replies.dueNow ? ` (${options.replies.dueNow} to send now)` : ""}`);
  }
  // Slug only: a cross-board queue needs to know which codebase a line belongs
  // to, and the full path belongs on the card, not on every row of a list.
  if ("project" in task && task.project) parts.push(`project=${task.project.slug}`);
  if (options.showBoard && "boardName" in task) parts.push(`board=${task.boardName}`);
  if (options.showBoard && "columnName" in task) parts.push(`state=${task.columnName}`);
  if (task.blockedReason) parts.push(`blocked=${task.blockedReason}`);
  return parts.join("  ");
}

/**
 * Where work on something happens, as one line.
 *
 * The existence check is the reason this is a function rather than a template: a
 * directory that has been moved or deleted turns a delegated run into a failure
 * the model cannot diagnose, so the path being wrong is said here, at the moment
 * the model reads the card, rather than discovered later.
 */
function projectLine(project: ResolvedProject | Project | null | undefined, indent = ""): string | null {
  if (!project) return null;
  const via = "via" in project ? (project.via === "task" ? "set on this card" : "inherited from the board") : null;
  const missing = projectPathExists(project.path) ? "" : "  !! THIS DIRECTORY DOES NOT EXIST ANY MORE";
  return (
    `${indent}project: ${project.slug} — ${project.path}${via ? `  (${via})` : ""}${missing}` +
    (project.description ? `\n${indent}  what it is: ${project.description.replace(/\s+/g, " ").slice(0, 300)}` : "")
  );
}

export function renderProjects(projects: Project[]): string {
  if (projects.length === 0) {
    return "No projects registered. Use project_add to point one at a directory on this machine.";
  }
  return [
    `${projects.length} project(s):`,
    "",
    ...projects.map((project) =>
      [
        `  ${project.slug}  (${project.id})${project.archived ? "  [archived]" : ""}`,
        `    name: ${project.name}`,
        `    path: ${project.path}${projectPathExists(project.path) ? "" : "  !! MISSING"}`,
        project.description ? `    what it is: ${project.description}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    ),
    "",
    "Attach one with board_update project=<slug> (the default for every card on a board)",
    "or task_update project=<slug> (this card only). An @claude request on a card with a",
    "project is carried out inside that directory.",
  ].join("\n");
}

export function renderBoard(detail: BoardDetail, options: { includeDone?: boolean } = {}): string {
  const { board, window, columns, tasks, stats } = detail;
  // Per-card counts, so the board view says *which* cards are waiting on a reply
  // and not just how many are.
  const waiting = new Map<string, number>();
  for (const mention of detail.openMentions) waiting.set(mention.taskId, (waiting.get(mention.taskId) ?? 0) + 1);
  const replies = new Map(detail.responses.map((entry) => [entry.taskId, entry]));
  const deadline = window.expired
    ? `EXPIRED ${humanizeDuration(window.remainingMs)} ago`
    : `${humanizeDuration(window.remainingMs)} left`;

  const lines = [
    `${board.name}  (${board.id})${board.archived ? "  [archived]" : ""}`,
    `duration=${board.durationKind}  window=${window.label}  ends=${shortDate(board.endsAt)}  ${deadline}`,
    board.description ? `note: ${board.description}` : null,
    projectLine(detail.project),
    `tasks=${stats.total}  done=${stats.done}  active=${stats.active}  blocked=${stats.blocked}  review=${stats.review}  overdue=${stats.overdue}`,
    `assigned: Claude=${stats.assignedToClaude}  Me=${stats.assignedToMe}  unassigned=${stats.unassigned}`,
    // Loud, because an unanswered @claude is the user waiting on a reply.
    stats.openMentions > 0
      ? `>> ${stats.openMentions} unanswered @claude request(s) in this board's comments — call mentions to read them.`
      : null,
    syncLine(detail.sync),
    responsesLine(detail.responses),
    intakeLine(detail.intake),
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
    for (const task of shown) {
      lines.push(taskLine(task, { openMentions: waiting.get(task.id), replies: replies.get(task.id) }));
    }
    if (hidden) lines.push(`  ... ${hidden} more done task(s); pass includeDone to list them`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** One line on the replies this board's cards still owe, or nothing to say. */
function responsesLine(counts: BoardDetail["responses"]): string | null {
  if (counts.length === 0) return null;
  const open = counts.reduce((total, entry) => total + entry.open, 0);
  const dueNow = counts.reduce((total, entry) => total + entry.dueNow, 0);
  return (
    `replies: ${open} draft(s) across ${counts.length} card(s)` +
    (dueNow ? `, ${dueNow} ready for the user to send` : "") +
    " — call responses to read them"
  );
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
  project?: ResolvedProject | null;
  openMentions?: MentionWithContext[];
  responses?: TaskResponseSummary;
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
    // Where the work happens. On a card like "fix the duplicate button on the
    // facility details page", this line is the difference between a card you can
    // act on and one you can only talk about.
    projectLine(input.project),
    // Before the description, because an open request changes what to do with
    // everything below it.
    open.length > 0
      ? `\nOPEN @claude REQUEST(S) ON THIS CARD:\n${open.map(mentionRequestLine).join("\n")}`
      : null,
    "",
    task.description ? `description:\n${task.description}` : "description: (none)",
    "",
    // Before the comments: on a card that came out of an inbox, the reply the
    // user owes is the point of the card, not a footnote to it.
    input.responses ? renderResponseSummary(input.responses) : null,
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
    // Carry the directory with the ask itself: a request to fix something is only
    // answerable if you know which checkout it is in.
    projectLine(mention.project, "  "),
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

/* ---------------------------------------------------------------- responses */

const STAGE_LABEL: Record<string, string> = {
  acknowledge: "send now",
  completion: "send when the work is done",
};

/**
 * One draft reply in full. The body is included verbatim and unwrapped: the point
 * of reading a draft is to judge the words, and a summary of a message is not a
 * message.
 */
export function renderResponse(response: ResponseWithContext, options: { includeThread?: boolean } = {}): string {
  const lines = [
    `${response.id}  [${response.status}]  ${response.channel === "email" ? "EMAIL" : "TEAMS CHAT"}` +
      `  stage=${response.stage} (${STAGE_LABEL[response.stage] ?? response.stage})` +
      `${response.dueNow ? "  << SEND THIS ONE NOW" : ""}`,
    `  to: ${response.recipientName}${response.recipientRef ? ` <${response.recipientRef}>` : ""}` +
      (response.cc.length > 0 ? `  cc: ${response.cc.join(", ")}` : ""),
    response.subject !== null ? `  subject: ${response.subject}` : null,
    `  on task ${response.taskId} "${response.taskTitle}"  state=${response.columnName} (${response.columnKind})`,
    response.sourceRef ? `  replying to: ${response.sourceRef}` : null,
    `  revision ${response.revision}, updated ${shortDate(response.updatedAt)}` +
      (response.sentAt ? `, marked sent ${shortDate(response.sentAt)} by the user` : ""),
    "  --- body ---",
    response.body
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "  --- end ---",
  ].filter((line): line is string => line !== null);

  if (response.activeTurn) {
    lines.push(
      `  IN FLIGHT: ${response.activeTurn.id} [${response.activeTurn.status}] — "${response.activeTurn.instruction}"`,
    );
  }
  if (options.includeThread && response.turns.length > 0) {
    lines.push("  changes so far:", ...response.turns.map((turn) => `    ${turnLine(turn)}`));
  }
  return lines.join("\n");
}

/** One turn as a line of transcript: what was asked, and what came back. */
const turnLine = (turn: ResponseTurn): string =>
  `[${shortDate(turn.createdAt)}] ${turn.kind} (${turn.status}): ${turn.instruction}` +
  (turn.note ? `  -> ${turn.note}` : "");

export function renderResponses(responses: ResponseWithContext[], heading: string): string {
  if (responses.length === 0) return `${heading}\n  (no replies drafted)`;
  const due = responses.filter((response) => response.dueNow).length;
  return [
    `${heading}  --  ${responses.length} draft(s)${due ? `, ${due} to send now` : ""}`,
    "",
    responses.map((response) => renderResponse(response)).join("\n\n"),
  ].join("\n");
}

/**
 * A card's replies, compressed to one line each. Used inside `task_get`, where the
 * card is the subject and the drafts are context — `responses` renders them in
 * full when the drafts themselves are what is being read.
 */
export function renderResponseSummary(summary: TaskResponseSummary): string {
  if (summary.responses.length === 0 && !summary.activeDraftTurn) {
    return "replies: none drafted (response_draft writes one, and a synced card should have them)";
  }
  const lines = ["replies owed:"];
  for (const response of summary.responses) {
    lines.push(
      `  ${response.id}  [${response.status}]  ${response.channel}  ${response.stage}` +
        `  to ${response.recipientName}${response.dueNow ? "  << now" : ""}` +
        (response.activeTurn ? `  (being rewritten)` : "") +
        `\n      ${response.body.replace(/\s+/g, " ").slice(0, 140)}${response.body.length > 140 ? "…" : ""}`,
    );
  }
  if (summary.activeDraftTurn) {
    lines.push(`  a draft pass is queued for this card: ${summary.activeDraftTurn.id} [${summary.activeDraftTurn.status}]`);
  }
  return lines.join("\n");
}

/**
 * A queued turn, rendered as the job spec rather than a summary: the instruction,
 * the message it applies to, and the card it belongs to, so one call is enough to
 * carry it out.
 */
export function renderResponseTurn(turn: ResponseTurnWithContext): string {
  const lines = [
    `${turn.id}  [${turn.status}]  kind=${turn.kind}  asked by ${turn.requestedByName} ${shortDate(turn.createdAt)} via ${turn.actorSource}`,
    `  instruction: ${turn.instruction}`,
    `  on task ${turn.taskId} "${turn.taskTitle}"  state=${turn.columnName} (${turn.columnKind})`,
    `  board "${turn.boardName}" closes ${shortDate(turn.boardEndsAt)}`,
    turn.taskSourceRef ? `  card imported from: ${turn.taskSourceRef}` : null,
    turn.attempts > 1 ? `  attempt ${turn.attempts} — an earlier run did not finish` : null,
  ].filter((line): line is string => line !== null);

  if (turn.response) {
    const response = turn.response;
    lines.push(
      `  the reply to change: ${response.id}  ${response.channel === "email" ? "EMAIL" : "TEAMS CHAT"}  stage=${response.stage}`,
      `    to ${response.recipientName}${response.recipientRef ? ` <${response.recipientRef}>` : ""}`,
      response.subject !== null ? `    subject: ${response.subject}` : "    (a chat message — no subject line)",
      "    --- current body ---",
      response.body
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
      "    --- end ---",
    );
  }
  if (turn.note) lines.push(`  outcome: ${turn.note}`);
  return lines.join("\n");
}

export function renderResponseTurns(turns: ResponseTurnWithContext[], heading: string): string {
  if (turns.length === 0) return `${heading}\n  (nothing queued)`;
  return [
    `${heading}  --  ${turns.length} turn(s), oldest first`,
    "",
    turns.map(renderResponseTurn).join("\n\n"),
  ].join("\n");
}

/* ------------------------------------------------------------------- intake */

const humanBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Rough shape of a pasted block, so the model knows what it is looking at before
 * reading it. A CSV's row and column count is the single most useful fact about it,
 * and counting delimiters is cheap enough to be worth doing here.
 */
function shapeOf(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  const first = lines[0] ?? "";
  const commas = (first.match(/,/g) ?? []).length;
  const tabs = (first.match(/\t/g) ?? []).length;
  if (lines.length > 1 && (commas >= 1 || tabs >= 1)) {
    const delimiter = tabs > commas ? "tab" : "comma";
    return `${lines.length} line(s), looks ${delimiter}-separated with ${(tabs > commas ? tabs : commas) + 1} column(s)`;
  }
  return `${lines.length} line(s), ${text.length} chars`;
}

function attachmentLine(attachment: IntakeAttachment, absolutePath?: string): string {
  const head = `  - ${attachment.filename}  [${attachment.kind}]  ${humanBytes(attachment.bytes)}`;
  if (attachment.kind === "text") return `${head}  (contents inlined below)`;
  return `${head}\n      open it with Read: ${absolutePath ?? "(path unavailable)"}`;
}

/**
 * One queued paste, rendered as the job spec rather than a summary: the material
 * itself is here in full, because the whole point is to act on it, and a truncated
 * CSV would produce a truncated board.
 */
export function renderIntakeMessage(message: IntakeMessageWithContext): string {
  const readable = new Map(message.readablePaths.map((entry) => [entry.id, entry.absolutePath]));
  const lines = [
    `${message.id}  [${message.status}]  pasted by ${message.requestedByName} ${shortDate(message.createdAt)} via ${message.actorSource}`,
    `  board: "${message.boardName}" (${message.boardId})  window ${shortDate(message.boardStartsAt)} to ${shortDate(message.boardEndsAt)} [${message.boardDurationKind}]`,
    message.boardDescription ? `  board note: ${message.boardDescription}` : null,
    message.attempts > 1 ? `  attempt ${message.attempts} — an earlier run did not finish` : null,
    "",
    message.instruction
      ? `WHAT THEY ASKED FOR:\n  ${message.instruction}`
      : "WHAT THEY ASKED FOR:\n  (nothing typed — they pasted the material and left it to you)",
  ].filter((line): line is string => line !== null);

  if (message.attachments.length > 0) {
    lines.push(
      "",
      `FILES (${message.attachments.length}):`,
      ...message.attachments.map((attachment) => attachmentLine(attachment, readable.get(attachment.id))),
    );
  }

  if (message.content) {
    lines.push("", `PASTED CONTENT — ${shapeOf(message.content)}:`, "--- begin ---", message.content, "--- end ---");
  }

  for (const attachment of message.attachments) {
    if (attachment.kind !== "text" || attachment.text === null) continue;
    lines.push(
      "",
      `FILE "${attachment.filename}" — ${shapeOf(attachment.text)}:`,
      "--- begin ---",
      attachment.text,
      "--- end ---",
    );
  }

  if (message.note) lines.push("", `outcome: ${message.note}`);
  if (message.createdTasks.length > 0) lines.push(`created: ${message.createdTasks.join(", ")}`);
  return lines.join("\n");
}

/** Queue listing: enough to choose one, without dumping every CSV into the reply. */
export function renderIntakeQueue(messages: IntakeMessageWithFiles[], heading: string): string {
  if (messages.length === 0) return `${heading}\n  (nothing pasted)`;
  const lines = [`${heading}  --  ${messages.length} message(s), oldest first`, ""];
  for (const message of messages) {
    const files = message.attachments.length > 0
      ? `  files: ${message.attachments.map((file) => `${file.filename} [${file.kind}]`).join(", ")}`
      : "";
    lines.push(
      `${message.id}  [${message.status}]  ${shortDate(message.createdAt)}  board=${message.boardId}`,
      `  asked: ${message.instruction || "(nothing typed)"}`,
      message.content ? `  pasted: ${shapeOf(message.content)}` : "",
      files,
      message.note ? `  outcome: ${message.note}` : "",
      "",
    );
  }
  return lines.filter((line) => line !== "").join("\n");
}

/** One line on a board's intake chat, or nothing to say. */
function intakeLine(intake: BoardDetail["intake"]): string | null {
  if (intake.open > 0) {
    return `intake chat: ${intake.open} pasted message(s) waiting to be turned into cards — call intake_pending`;
  }
  return null;
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
