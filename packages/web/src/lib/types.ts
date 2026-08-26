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

export interface Board {
  id: string;
  name: string;
  description: string | null;
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
}

export type SyncSource = "outlook" | "teams";
export type SyncStatus = "pending" | "running" | "ok" | "failed" | "cancelled";

/** Per-source watermark: everything up to `syncedThrough` has been considered. */
export interface BoardSyncState {
  boardId: string;
  source: SyncSource;
  syncedThrough: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastDetail: string | null;
  imported: number;
  updatedAt: string;
}

export interface SyncScopeEntry {
  source: SyncSource;
  since: string;
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
  sources: BoardSyncState[];
  activeRun: SyncRun | null;
  lastRun: SyncRun | null;
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
  window: BoardWindow;
  columns: BoardColumn[];
  tasks: Task[];
  stats: BoardStats;
  openMentions: MentionWithContext[];
  sync: BoardSyncSummary;
}

export interface TaskDetail {
  task: Task;
  board: Board;
  column: BoardColumn;
  window: BoardWindow;
  comments: TaskComment[];
  openMentions: MentionWithContext[];
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

export const SYNC_SOURCE_LABELS: Record<SyncSource, string> = { outlook: "Outlook", teams: "Teams" };

export const kindColor = (kind: ColumnKind): string => `var(--kind-${kind})`;
export const priorityColor = (priority: Priority): string => `var(--prio-${priority})`;
