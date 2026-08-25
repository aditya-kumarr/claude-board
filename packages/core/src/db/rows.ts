import type {
  ActivityEntry,
  Board,
  BoardColumn,
  ColumnKind,
  DurationKind,
  Mention,
  MentionStatus,
  Priority,
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
