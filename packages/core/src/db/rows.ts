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
  SyncSourceProgress,
  SyncSource,
  SyncStatus,
  Task,
  TaskComment,
  User,
  ActorSource,
  ResponseChannel,
  ResponseOrigin,
  ResponseStage,
  ResponseStatus,
  ResponseTurn,
  ResponseTurnKind,
  ResponseTurnStatus,
  TaskResponse,
  IntakeAttachment,
  IntakeAttachmentKind,
  IntakeMessage,
  IntakeStatus,
  Project,
  ProjectSource,
  ResolvedProject,
} from "../types.ts";

/** Raw snake_case shapes as they come back from bun:sqlite. */
export interface UserRow {
  id: string;
  display_name: string;
  kind: "human" | "agent";
  created_at: string;
}
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  path: string;
  description: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}
export interface BoardRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
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
  project_id: string | null;
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
  cooldown_until: string | null;
  progress: string | null;
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
export interface ResponseRow {
  id: string;
  task_id: string;
  board_id: string;
  channel: string;
  stage: string;
  status: string;
  recipient_name: string;
  recipient_ref: string | null;
  cc: string | null;
  subject: string | null;
  body: string;
  source: string;
  source_ref: string | null;
  created_by: string;
  actor_source: string;
  revision: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ResponseTurnRow {
  id: string;
  response_id: string | null;
  task_id: string;
  board_id: string;
  kind: string;
  instruction: string;
  status: string;
  requested_by: string;
  actor_source: string;
  attempts: number;
  note: string | null;
  result_subject: string | null;
  result_body: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  created_at: string;
}
export interface IntakeMessageRow {
  id: string;
  board_id: string;
  instruction: string;
  content: string | null;
  status: string;
  requested_by: string;
  actor_source: string;
  attempts: number;
  note: string | null;
  created_tasks: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  created_at: string;
}
export interface IntakeAttachmentRow {
  id: string;
  message_id: string;
  board_id: string;
  filename: string;
  mime: string;
  kind: string;
  bytes: number;
  path: string;
  text: string | null;
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

export const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  path: row.path,
  description: row.description,
  archived: row.archived === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Columns a card's *effective* project comes back as, from a query that joins
 * `projects` twice — the task's and the board's. See `PROJECT_CONTEXT_COLUMNS`.
 */
export interface ProjectContextRow {
  project_id: string | null;
  project_name: string | null;
  project_slug: string | null;
  project_path: string | null;
  project_description: string | null;
  project_via: string | null;
}

export const toResolvedProject = (row: ProjectContextRow): ResolvedProject | null =>
  row.project_id === null || row.project_via === null
    ? null
    : {
        id: row.project_id,
        name: row.project_name ?? row.project_id,
        slug: row.project_slug ?? row.project_id,
        path: row.project_path ?? "",
        description: row.project_description,
        via: row.project_via as ProjectSource,
      };

export const toBoard = (row: BoardRow): Board => ({
  id: row.id,
  name: row.name,
  description: row.description,
  projectId: row.project_id,
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
  projectId: row.project_id,
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

function parseProgress(raw: string | null): SyncSourceProgress | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncSourceProgress;
    // A malformed blob must not make the whole row unreadable; losing resume
    // state costs a re-read, losing the watermark would cost correctness.
    // A blob missing either end of its window cannot be resumed against a known
    // window, so treat it as no progress: the pass restarts, which costs a re-read
    // and never correctness.
    if (typeof parsed?.passCutoff !== "string" || typeof parsed?.passSince !== "string") return null;
    if (!Array.isArray(parsed.doneKeys)) return null;
    return { ...parsed, scanned: parsed.doneKeys.length };
  } catch {
    return null;
  }
}

export const toSyncState = (row: SyncStateRow): BoardSyncState => ({
  boardId: row.board_id,
  source: row.source as SyncSource,
  syncedThrough: row.synced_through,
  lastRunAt: row.last_run_at,
  lastStatus: row.last_status as "ok" | "failed" | null,
  lastDetail: row.last_detail,
  imported: row.imported,
  cooldownUntil: row.cooldown_until,
  progress: parseProgress(row.progress),
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

/** `cc` is stored as JSON; a malformed value must not make the draft unreadable. */
function parseCc(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export const toResponse = (row: ResponseRow): TaskResponse => ({
  id: row.id,
  taskId: row.task_id,
  boardId: row.board_id,
  channel: row.channel as ResponseChannel,
  stage: row.stage as ResponseStage,
  status: row.status as ResponseStatus,
  recipientName: row.recipient_name,
  recipientRef: row.recipient_ref,
  cc: parseCc(row.cc),
  subject: row.subject,
  body: row.body,
  source: row.source as ResponseOrigin,
  sourceRef: row.source_ref,
  createdBy: row.created_by,
  actorSource: row.actor_source as ActorSource,
  revision: row.revision,
  sentAt: row.sent_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toResponseTurn = (row: ResponseTurnRow): ResponseTurn => ({
  id: row.id,
  responseId: row.response_id,
  taskId: row.task_id,
  boardId: row.board_id,
  kind: row.kind as ResponseTurnKind,
  instruction: row.instruction,
  status: row.status as ResponseTurnStatus,
  requestedBy: row.requested_by,
  actorSource: row.actor_source as ActorSource,
  attempts: row.attempts,
  note: row.note,
  resultSubject: row.result_subject,
  resultBody: row.result_body,
  claimedAt: row.claimed_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

/** Ids of the cards a message produced. A malformed list must not hide the reply. */
function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export const toIntakeMessage = (row: IntakeMessageRow): IntakeMessage => ({
  id: row.id,
  boardId: row.board_id,
  instruction: row.instruction,
  content: row.content,
  status: row.status as IntakeStatus,
  requestedBy: row.requested_by,
  actorSource: row.actor_source as ActorSource,
  attempts: row.attempts,
  note: row.note,
  createdTasks: parseIds(row.created_tasks),
  claimedAt: row.claimed_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

export const toIntakeAttachment = (row: IntakeAttachmentRow): IntakeAttachment => ({
  id: row.id,
  messageId: row.message_id,
  boardId: row.board_id,
  filename: row.filename,
  mime: row.mime,
  kind: row.kind as IntakeAttachmentKind,
  bytes: row.bytes,
  path: row.path,
  text: row.text,
  createdAt: row.created_at,
});
