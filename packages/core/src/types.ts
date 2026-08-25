/** Every board is time-boxed: this is the shape of the box. */
export const DURATION_KINDS = ["day", "week", "month", "quarter", "year", "custom"] as const;
export type DurationKind = (typeof DURATION_KINDS)[number];

/**
 * Semantic role of a column. Column *names* are free-form and users may add as
 * many as they like; the kind is what the app reasons about (which cards count
 * as finished, which are waiting on something, which are up for review).
 */
export const COLUMN_KINDS = ["backlog", "active", "blocked", "review", "done"] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ACTOR_SOURCES = ["web", "mcp", "system"] as const;
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/**
 * Lifecycle of an `@claude` request left in a comment thread. `pending` is the
 * inbox, `claimed` means an agent has taken it (so a second runner leaves it
 * alone), and the two terminal states record whether it was carried out or
 * deliberately not.
 */
export const MENTION_STATUSES = ["pending", "claimed", "answered", "dismissed"] as const;
export type MentionStatus = (typeof MENTION_STATUSES)[number];

/** Statuses that still need someone to act. */
export const OPEN_MENTION_STATUSES: readonly MentionStatus[] = ["pending", "claimed"];

/** Seeded, stable ids so both the UI and the agent can reference assignees. */
export const USER_ME = "me";
export const USER_CLAUDE = "claude";

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
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

/** An `@claude` in a comment, promoted to a tracked request. */
export interface Mention {
  id: string;
  taskId: string;
  boardId: string;
  /** The comment that contains the mention; its body *is* the request. */
  commentId: string;
  /** Who was asked. Only agent-kind users get a mention row. */
  targetId: string;
  requestedBy: string;
  status: MentionStatus;
  /** Transport the mentioning comment arrived over. */
  source: ActorSource;
  claimedAt: string | null;
  resolvedAt: string | null;
  /** What was done about it, written when resolving. */
  resolution: string | null;
  createdAt: string;
}

/**
 * A mention plus everything needed to act on it without another lookup — the
 * ask itself, the card it hangs off, and that card's board deadline.
 */
export interface MentionWithContext extends Mention {
  /** Full text of the mentioning comment. */
  body: string;
  /** The comment with the leading `@handle` stripped. */
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

export interface ActivityEntry {
  id: number;
  boardId: string | null;
  taskId: string | null;
  actorId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  source: ActorSource;
  createdAt: string;
}

/** Rolled-up counts the UI header and the agent's board summary both use. */
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
  /** Unresolved `@claude` requests sitting in this board's comment threads. */
  openMentions: number;
}

export interface BoardWindow {
  startsAt: string;
  endsAt: string;
  /** Human label, e.g. "Week of 17–23 Aug 2026". */
  label: string;
  totalMs: number;
  elapsedMs: number;
  remainingMs: number;
  /** 0–1, clamped. */
  progress: number;
  expired: boolean;
}

export interface BoardDetail {
  board: Board;
  window: BoardWindow;
  columns: BoardColumn[];
  tasks: Task[];
  stats: BoardStats;
  /**
   * Unresolved `@claude` requests on this board's cards. Carried on the board
   * rather than fetched per card so the UI can mark which cards are waiting on
   * a reply without a request per task.
   */
  openMentions: MentionWithContext[];
}
