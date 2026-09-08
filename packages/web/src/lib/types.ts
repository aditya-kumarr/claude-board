/** Mirrors the wire format from @automation/core. Kept local so the web build stays standalone. */
export type DurationKind = "day" | "week" | "month" | "quarter" | "year" | "custom";
export type ColumnKind = "backlog" | "active" | "blocked" | "review" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface User {
  id: string;
  displayName: string;
  kind: "human" | "agent";
  createdAt: string;
}

/**
 * A directory on the machine running the board, that work on a card can be
 * carried out *inside*. A card with one resolved against it is a card an
 * `@claude` request can actually fix rather than only discuss.
 */
export interface Project {
  id: string;
  name: string;
  slug: string;
  path: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Where a card's project came from: the card names one, or its board does. */
export type ProjectSource = "task" | "board";

/** A card's effective project: its own if it has one, otherwise its board's. */
export interface ResolvedProject {
  id: string;
  name: string;
  slug: string;
  path: string;
  description: string | null;
  via: ProjectSource;
}

export interface Board {
  id: string;
  name: string;
  description: string | null;
  /** Default project for every card on this board. A card may override it. */
  projectId: string | null;
  durationKind: DurationKind;
  startsAt: string;
  endsAt: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardColumn {
  id: string;
  boardId: string;
  key: string;
  name: string;
  kind: ColumnKind;
  position: number;
  wipLimit: number | null;
  createdAt: string;
}

export interface Task {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  assigneeId: string | null;
  createdBy: string;
  priority: Priority;
  dueAt: string | null;
  position: number;
  completedAt: string | null;
  blockedReason: string | null;
  /**
   * Overrides the board's project for this card. `null` is not "no project" — it
   * means the card inherits whatever its board points at.
   */
  projectId: string | null;
  /** Import key when this card came from Outlook or Teams. */
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWithContext extends Task {
  boardName: string;
  boardEndsAt: string;
  columnKey: string;
  columnName: string;
  columnKind: ColumnKind;
  overdue: boolean;
  /** Where this card's work happens, already resolved through its board. */
  project: ResolvedProject | null;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export type MentionStatus = "pending" | "claimed" | "answered" | "dismissed";

/** An `@claude` in a comment, promoted to a request Claude is expected to act on. */
export interface Mention {
  id: string;
  taskId: string;
  boardId: string;
  commentId: string;
  targetId: string;
  requestedBy: string;
  status: MentionStatus;
  source: "web" | "mcp" | "system";
  claimedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

export interface MentionWithContext extends Mention {
  body: string;
  request: string;
  requestedByName: string;
  taskTitle: string;
  taskDescription: string | null;
  taskAssigneeId: string | null;
  taskPriority: Priority;
  taskDueAt: string | null;
  taskOverdue: boolean;
  boardName: string;
  boardEndsAt: string;
  columnKey: string;
  columnName: string;
  columnKind: ColumnKind;
  /** The directory this request will be carried out in, already resolved. */
  project: ResolvedProject | null;
}

export type SyncSource = "outlook" | "teams";
export type SyncStatus = "pending" | "running" | "ok" | "failed" | "cancelled";

/** Per-source watermark: everything up to `syncedThrough` has been considered. */
/** Resume state for a source read in batches across several runs. */
export interface SyncSourceProgress {
  passSince: string;
  passCutoff: string;
  doneKeys: string[];
  scanned: number;
  total: number | null;
  cursor: string | null;
  updatedAt: string;
}

export interface BoardSyncState {
  boardId: string;
  source: SyncSource;
  syncedThrough: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastDetail: string | null;
  imported: number;
  /** When a source throttled by Graph may be scanned again. Null means now. */
  cooldownUntil: string | null;
  /** Set while a multi-run pass over this source is still going. */
  progress: SyncSourceProgress | null;
  updatedAt: string;
}

export interface SyncScopeEntry {
  source: SyncSource;
  since: string;
  /** Watermark skipped past when the source's lookback cap moved `since` forward. */
  cappedFrom?: string;
}

/** A source deliberately left out of a run, and when it comes back. */
export interface SyncSkip {
  source: SyncSource;
  reason: "cooldown" | "interval";
  nextEligibleAt: string;
  detail: string;
}

export interface SyncRun {
  id: string;
  boardId: string;
  scope: SyncScopeEntry[];
  status: SyncStatus;
  requestedBy: string;
  actorSource: "web" | "mcp" | "system";
  since: string;
  cutoff: string;
  imported: number;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BoardSyncSummary {
  /** Sources a press would leave out right now, and when each becomes eligible. */
  skips: SyncSkip[];
  sources: BoardSyncState[];
  activeRun: SyncRun | null;
  lastRun: SyncRun | null;
}

/* ---- draft replies ---- */

/** An email carries a subject line; a Teams message does not. */
export type ResponseChannel = "email" | "chat";
/** `acknowledge` is the reply to send now, `completion` the one for when it is done. */
export type ResponseStage = "acknowledge" | "completion";
/** `sent` is the user recording that *they* sent it — nothing here sends anything. */
export type ResponseStatus = "draft" | "approved" | "sent" | "discarded";
export type ResponseOrigin = "outlook" | "teams" | "manual";
export type ResponseTurnKind = "draft" | "revise" | "edit";
export type ResponseTurnStatus = "pending" | "claimed" | "done" | "failed" | "cancelled";

/** A draft reply owed to one person on one card. */
export interface TaskResponse {
  id: string;
  taskId: string;
  boardId: string;
  channel: ResponseChannel;
  stage: ResponseStage;
  status: ResponseStatus;
  recipientName: string;
  recipientRef: string | null;
  cc: string[];
  /** `null` for a chat message, which has no subject line. */
  subject: string | null;
  body: string;
  source: ResponseOrigin;
  sourceRef: string | null;
  createdBy: string;
  actorSource: "web" | "mcp" | "system";
  revision: number;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One exchange about a draft — the queue and the chat transcript are the same
 * table, because a pending turn is work and a finished one is a message.
 */
export interface ResponseTurn {
  id: string;
  responseId: string | null;
  taskId: string;
  boardId: string;
  kind: ResponseTurnKind;
  instruction: string;
  status: ResponseTurnStatus;
  requestedBy: string;
  actorSource: "web" | "mcp" | "system";
  attempts: number;
  /** Claude's side of the exchange, or why it failed. */
  note: string | null;
  resultSubject: string | null;
  resultBody: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ResponseWithContext extends TaskResponse {
  taskTitle: string;
  taskDescription: string | null;
  taskSourceRef: string | null;
  taskDueAt: string | null;
  taskCompletedAt: string | null;
  columnKey: string;
  columnName: string;
  columnKind: ColumnKind;
  boardName: string;
  boardEndsAt: string;
  /** Whether this is the one to send right now. */
  dueNow: boolean;
  turns: ResponseTurn[];
  activeTurn: ResponseTurn | null;
}

export interface ResponseTurnWithContext extends ResponseTurn {
  taskTitle: string;
  taskDescription: string | null;
  taskSourceRef: string | null;
  taskDueAt: string | null;
  columnKey: string;
  columnName: string;
  columnKind: ColumnKind;
  boardName: string;
  boardEndsAt: string;
  requestedByName: string;
  response: TaskResponse | null;
}

export interface TaskResponseSummary {
  responses: ResponseWithContext[];
  activeDraftTurn: ResponseTurn | null;
}

/** Per-card reply counts, carried on the board so cards can be badged. */
export interface BoardResponseCount {
  taskId: string;
  open: number;
  dueNow: number;
  working: boolean;
}

/* ---- the board's intake chat ---- */

export type IntakeStatus = "pending" | "claimed" | "done" | "failed" | "cancelled";
/** `text` was decoded at upload and rides in the prompt; the rest is read from disk. */
export type IntakeAttachmentKind = "text" | "image" | "pdf";

export interface IntakeAttachment {
  id: string;
  messageId: string;
  boardId: string;
  filename: string;
  mime: string;
  kind: IntakeAttachmentKind;
  bytes: number;
  path: string;
  text: string | null;
  createdAt: string;
}

/** One turn of the chat: what was pasted, and what came of it. */
export interface IntakeMessage {
  id: string;
  boardId: string;
  instruction: string;
  content: string | null;
  status: IntakeStatus;
  requestedBy: string;
  actorSource: "web" | "mcp" | "system";
  attempts: number;
  /** Claude's reply, or why nothing happened. */
  note: string | null;
  /** Cards this message produced, rendered as chips in the chat. */
  createdTasks: string[];
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface IntakeMessageWithFiles extends IntakeMessage {
  attachments: IntakeAttachment[];
}

export interface BoardIntakeSummary {
  open: number;
  working: boolean;
  total: number;
  lastMessageAt: string | null;
}

/** A file refused at upload, with the reason to show against it. */
export interface IntakeRejection {
  filename: string;
  reason: string;
}

export interface ActivityEntry {
  id: number;
  boardId: string | null;
  taskId: string | null;
  actorId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  source: "web" | "mcp" | "system";
  createdAt: string;
}

export interface BoardStats {
  total: number;
  done: number;
  blocked: number;
  review: number;
  active: number;
  backlog: number;
  overdue: number;
  assignedToMe: number;
  assignedToClaude: number;
  unassigned: number;
  openMentions: number;
}

export interface BoardWindow {
  startsAt: string;
  endsAt: string;
  label: string;
  totalMs: number;
  elapsedMs: number;
  remainingMs: number;
  progress: number;
  expired: boolean;
}

export interface BoardDetail {
  board: Board;
  /** The board's default project, resolved. */
  project: Project | null;
  window: BoardWindow;
  columns: BoardColumn[];
  tasks: Task[];
  stats: BoardStats;
  openMentions: MentionWithContext[];
  sync: BoardSyncSummary;
  responses: BoardResponseCount[];
  intake: BoardIntakeSummary;
}

export interface TaskDetail {
  task: Task;
  board: Board;
  column: BoardColumn;
  /** Where work on this card happens, resolved through the board. */
  project: ResolvedProject | null;
  window: BoardWindow;
  comments: TaskComment[];
  openMentions: MentionWithContext[];
  responses: TaskResponseSummary;
  overdue: boolean;
}

export const DURATION_LABELS: Record<DurationKind, string> = {
  day: "One day",
  week: "One week",
  month: "One month",
  quarter: "One quarter",
  year: "One year",
  custom: "Custom end date",
};

export const COLUMN_KIND_LABELS: Record<ColumnKind, string> = {
  backlog: "Backlog",
  active: "In progress",
  blocked: "Blocked",
  review: "Needs review",
  done: "Done",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const MENTION_STATUS_LABELS: Record<MentionStatus, string> = {
  pending: "Waiting for Claude",
  claimed: "Claude is on it",
  answered: "Answered",
  dismissed: "Not actioned",
};

export const RESPONSE_CHANNEL_LABELS: Record<ResponseChannel, string> = { email: "Email", chat: "Teams" };

/** Says what the stage *means*, not what it is called — the user never picked it. */
export const RESPONSE_STAGE_LABELS: Record<ResponseStage, string> = {
  acknowledge: "Send now",
  completion: "When it's done",
};

export const RESPONSE_STAGE_HINTS: Record<ResponseStage, string> = {
  acknowledge: "Confirms you have it and says what happens next.",
  completion: "Reports the outcome. Comes due when this card reaches a done state.",
};

export const RESPONSE_STATUS_LABELS: Record<ResponseStatus, string> = {
  draft: "Draft",
  approved: "Ready to send",
  sent: "Sent",
  discarded: "Discarded",
};

/** Stage drives the accent, so the two kinds of reply are told apart at a glance. */
export const stageColor = (stage: ResponseStage): string =>
  stage === "acknowledge" ? "var(--kind-active)" : "var(--kind-done)";

export const SYNC_SOURCE_LABELS: Record<SyncSource, string> = { outlook: "Outlook", teams: "Teams" };

export const kindColor = (kind: ColumnKind): string => `var(--kind-${kind})`;
export const priorityColor = (priority: Priority): string => `var(--prio-${priority})`;
