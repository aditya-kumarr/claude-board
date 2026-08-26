import type {
  ActivityEntry,
  Board,
  BoardColumn,
  ColumnKind,
  DurationKind,
  BoardSyncState,
  Mention,
  MentionStatus,
  Priority,
  SyncRun,
  SyncScopeEntry,
  SyncSource,
  SyncStatus,
  Task,
  TaskComment,
  User,
  ActorSource,
} from "../types.ts";

/** Raw snake_case shapes as they come back from bun:sqlite. */
export interface UserRow {
  id: string;
  display_name: string;
  kind: "human" | "agent";
  created_at: string;
}
export interface BoardRow {
  id: string;
  name: string;
  description: string | null;
  duration_kind: string;
  starts_at: string;
  ends_at: string;
  archived: number;
  created_at: string;
  updated_at: string;
}
export interface ColumnRow {
  id: string;
  board_id: string;
  key: string;
  name: string;
  kind: string;
  position: number;
  wip_limit: number | null;
  created_at: string;
}
export interface TaskRow {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  created_by: string;
  priority: string;
  due_at: string | null;
  position: number;
  completed_at: string | null;
  blocked_reason: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}
export interface CommentRow {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
}
export interface MentionRow {
  id: string;
  task_id: string;
  board_id: string;
  comment_id: string;
  target_id: string;
  requested_by: string;
  status: string;
  source: string;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
}
export interface SyncStateRow {
  board_id: string;
  source: string;
  synced_through: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_detail: string | null;
  imported: number;
  updated_at: string;
}
export interface SyncRunRow {
  id: string;
  board_id: string;
  scope: string;
  status: string;
  requested_by: string;
  actor_source: string;
  since: string;
  cutoff: string;
  imported: number;
  detail: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
export interface ActivityRow {
  id: number;
  board_id: string | null;
  task_id: string | null;
  actor_id: string | null;
  action: string;
  detail: string | null;
  source: string;
  created_at: string;
}

export const toUser = (row: UserRow): User => ({
  id: row.id,
  displayName: row.display_name,
  kind: row.kind,
  createdAt: row.created_at,
});

export const toBoard = (row: BoardRow): Board => ({
  id: row.id,
  name: row.name,
  description: row.description,
  durationKind: row.duration_kind as DurationKind,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  archived: row.archived === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toColumn = (row: ColumnRow): BoardColumn => ({
  id: row.id,
  boardId: row.board_id,
  key: row.key,
  name: row.name,
  kind: row.kind as ColumnKind,
  position: row.position,
  wipLimit: row.wip_limit,
  createdAt: row.created_at,
});

export const toTask = (row: TaskRow): Task => ({
  id: row.id,
  boardId: row.board_id,
  columnId: row.column_id,
  title: row.title,
  description: row.description,
  assigneeId: row.assignee_id,
  createdBy: row.created_by,
  priority: row.priority as Priority,
  dueAt: row.due_at,
  position: row.position,
  completedAt: row.completed_at,
  blockedReason: row.blocked_reason,
  sourceRef: row.source_ref,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toComment = (row: CommentRow): TaskComment => ({
  id: row.id,
  taskId: row.task_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: row.created_at,
});

export const toMention = (row: MentionRow): Mention => ({
  id: row.id,
  taskId: row.task_id,
  boardId: row.board_id,
  commentId: row.comment_id,
  targetId: row.target_id,
  requestedBy: row.requested_by,
  status: row.status as MentionStatus,
  source: row.source as ActorSource,
  claimedAt: row.claimed_at,
  resolvedAt: row.resolved_at,
  resolution: row.resolution,
  createdAt: row.created_at,
});

export const toSyncState = (row: SyncStateRow): BoardSyncState => ({
  boardId: row.board_id,
  source: row.source as SyncSource,
  syncedThrough: row.synced_through,
  lastRunAt: row.last_run_at,
  lastStatus: row.last_status as "ok" | "failed" | null,
  lastDetail: row.last_detail,
  imported: row.imported,
  updatedAt: row.updated_at,
});

export function toSyncRun(row: SyncRunRow): SyncRun {
  let scope: SyncScopeEntry[] = [];
  try {
    const parsed = JSON.parse(row.scope) as SyncScopeEntry[];
    if (Array.isArray(parsed)) scope = parsed;
  } catch {
    // A malformed scope must not make the run unreadable — the status and the
    // window still tell the operator what happened.
    scope = [];
  }
  return {
    id: row.id,
    boardId: row.board_id,
    scope,
    status: row.status as SyncStatus,
    requestedBy: row.requested_by,
    actorSource: row.actor_source as ActorSource,
    since: row.since,
    cutoff: row.cutoff,
    imported: row.imported,
    detail: row.detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function toActivity(row: ActivityRow): ActivityEntry {
  let detail: Record<string, unknown> | null = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = { raw: row.detail };
    }
  }
  return {
    id: row.id,
    boardId: row.board_id,
    taskId: row.task_id,
    actorId: row.actor_id,
    action: row.action,
    detail,
    source: row.source as ActorSource,
    createdAt: row.created_at,
  };
}
