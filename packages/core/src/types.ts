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

/**
 * Inboxes a board can pull pending work from. Both are reached through the
 * Microsoft 365 MCP server rather than from the API process, which holds no
 * Graph credentials of its own.
 */
export const SYNC_SOURCES = ["outlook", "teams"] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

/**
 * A sync is queued rather than performed inline: the process serving the button
 * cannot reach Microsoft Graph, so it records the request and an agent run picks
 * it up. `ok`/`failed` are terminal.
 */
export const SYNC_STATUSES = ["pending", "running", "ok", "failed", "cancelled"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Statuses where a run is still expected to do something. */
export const OPEN_SYNC_STATUSES: readonly SyncStatus[] = ["pending", "running"];

/**
 * How a reply goes out. Not cosmetic: an email carries a subject line and a Teams
 * message does not, so the two are validated and rendered differently.
 */
export const RESPONSE_CHANNELS = ["email", "chat"] as const;
export type ResponseChannel = (typeof RESPONSE_CHANNELS)[number];

/**
 * When a reply is meant to go out. A card imported from a mail usually needs two:
 * one now, to tell the sender it is in hand, and one once the work is actually
 * finished. They are different messages, so they are different drafts.
 */
export const RESPONSE_STAGES = ["acknowledge", "completion"] as const;
export type ResponseStage = (typeof RESPONSE_STAGES)[number];

/**
 * Lifecycle of a draft reply. `sent` is the human recording that *they* sent it —
 * nothing in this system sends mail or posts to Teams, by design.
 */
export const RESPONSE_STATUSES = ["draft", "approved", "sent", "discarded"] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** Statuses where the reply is still the user's to deal with. */
export const OPEN_RESPONSE_STATUSES: readonly ResponseStatus[] = ["draft", "approved"];

/** Where a draft came from. `manual` means the user wrote it themselves. */
export const RESPONSE_ORIGINS = ["outlook", "teams", "manual"] as const;
export type ResponseOrigin = (typeof RESPONSE_ORIGINS)[number];

/**
 * One exchange about a draft. `draft` asks for a card's replies to be written from
 * scratch, `revise` asks for a change to one of them, and `edit` records a change
 * the user made by hand — inserted already finished, so the thread the user reads
 * is one history rather than two.
 */
export const RESPONSE_TURN_KINDS = ["draft", "revise", "edit"] as const;
export type ResponseTurnKind = (typeof RESPONSE_TURN_KINDS)[number];

/**
 * A turn is queued work before it is a message. The Express process has no model
 * access, so asking Claude for a rewrite records the ask and an agent run carries
 * it out — the same split the Sync button lives with.
 */
export const RESPONSE_TURN_STATUSES = ["pending", "claimed", "done", "failed", "cancelled"] as const;
export type ResponseTurnStatus = (typeof RESPONSE_TURN_STATUSES)[number];

/** Statuses where a turn is still expected to produce something. */
export const OPEN_RESPONSE_TURN_STATUSES: readonly ResponseTurnStatus[] = ["pending", "claimed"];

/**
 * Lifecycle of one message pasted into a board's intake chat. Identical in shape
 * to a response turn, because it is the same bargain: the API process cannot ask
 * Claude anything, so pasting records the ask and an agent run carries it out.
 */
export const INTAKE_STATUSES = ["pending", "claimed", "done", "failed", "cancelled"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** Statuses where a message is still expected to produce cards. */
export const OPEN_INTAKE_STATUSES: readonly IntakeStatus[] = ["pending", "claimed"];

/**
 * What an attachment is, which decides how it reaches the model. `text` is decoded
 * at upload and travels inline in the prompt; `image` and `pdf` sit on disk and are
 * the only reason a run is ever given file access.
 */
export const INTAKE_ATTACHMENT_KINDS = ["text", "image", "pdf"] as const;
export type IntakeAttachmentKind = (typeof INTAKE_ATTACHMENT_KINDS)[number];

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
  /**
   * Where this card was imported from, e.g. `outlook:AAMkAD...`. Unique per
   * board, so re-running a sync over the same window cannot duplicate a card.
   */
  sourceRef: string | null;
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

/** Per-source watermark for one board. */
export interface BoardSyncState {
  boardId: string;
  source: SyncSource;
  /**
   * Everything up to this instant has already been considered. The next run
   * starts here, which is the whole point of keeping it.
   */
  syncedThrough: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastDetail: string | null;
  /** Cards created from this source, cumulative. */
  imported: number;
  updatedAt: string;
}

/** One source in a run's scope, with the window resolved for it. */
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
  actorSource: ActorSource;
  since: string;
  /** Becomes each scanned source's new watermark, but only if the run succeeds. */
  cutoff: string;
  imported: number;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface SyncRunWithContext extends SyncRun {
  boardName: string;
  boardStartsAt: string;
  boardEndsAt: string;
  boardDurationKind: DurationKind;
  boardDescription: string | null;
}

/** Everything the UI needs to render one board's Sync control. */
export interface BoardSyncSummary {
  sources: BoardSyncState[];
  /** A pending or running request, if one is outstanding. */
  activeRun: SyncRun | null;
  /** Most recent finished run, for "last synced" and the failure reason. */
  lastRun: SyncRun | null;
}

/** A draft reply owed to one person, on one card. Never sent by this system. */
export interface TaskResponse {
  id: string;
  taskId: string;
  boardId: string;
  channel: ResponseChannel;
  stage: ResponseStage;
  status: ResponseStatus;
  /** Display name of who it goes to, e.g. "Priya Sharma". */
  recipientName: string;
  /** Machine-usable address or chat id, and the slot key for uniqueness. */
  recipientRef: string | null;
  /** Additional addresses. Email only; always empty for chat. */
  cc: string[];
  /** Email only. `null` for a chat message, which has no subject line. */
  subject: string | null;
  body: string;
  source: ResponseOrigin;
  /** The message being replied to, e.g. `outlook:AAMk...`. Provenance only. */
  sourceRef: string | null;
  createdBy: string;
  actorSource: ActorSource;
  /** Bumped by every rewrite, so a stale editor can tell it is stale. */
  revision: number;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One exchange about a draft: what was asked, what came back, what it became. */
export interface ResponseTurn {
  id: string;
  /** `null` only for a card-level `draft` request, which has no draft yet. */
  responseId: string | null;
  taskId: string;
  boardId: string;
  kind: ResponseTurnKind;
  /** What was asked for, in the user's words. */
  instruction: string;
  status: ResponseTurnStatus;
  requestedBy: string;
  actorSource: ActorSource;
  attempts: number;
  /** Claude's side of the exchange, or the reason it failed. */
  note: string | null;
  /** Snapshot of the draft this turn produced, so the thread survives the next rewrite. */
  resultSubject: string | null;
  resultBody: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * A draft plus the card and board it hangs off, and whether it is the user's to
 * send yet. One read is enough to act on it.
 */
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
  /**
   * Whether this is the reply to send *now*. An `acknowledge` draft always is; a
   * `completion` draft only once the card has reached a done-kind column, which is
   * the whole reason the two are separate drafts.
   */
  dueNow: boolean;
  /** The exchange so far, oldest first. Empty when nothing has been asked yet. */
  turns: ResponseTurn[];
  /** A turn still expected to change this draft, if one is outstanding. */
  activeTurn: ResponseTurn | null;
}

/** A queued turn plus everything a run needs to carry it out without another lookup. */
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
  /** The draft being changed, for a `revise`. `null` for a `draft` request. */
  response: TaskResponse | null;
}

/** Everything a card's Replies section needs in one read. */
export interface TaskResponseSummary {
  responses: ResponseWithContext[];
  /** An outstanding card-level `draft` request, if one is queued. */
  activeDraftTurn: ResponseTurn | null;
}

/** Per-card reply counts, carried on the board so cards can be badged without a request each. */
export interface BoardResponseCount {
  taskId: string;
  /** Drafts still the user's to deal with (draft + approved). */
  open: number;
  /** Of those, the ones that are the user's to send right now. */
  dueNow: number;
  /** Whether Claude is mid-rewrite on any of them. */
  working: boolean;
}

/** One pasted or dropped file. */
export interface IntakeAttachment {
  id: string;
  messageId: string;
  boardId: string;
  filename: string;
  mime: string;
  kind: IntakeAttachmentKind;
  bytes: number;
  /** Relative to `INTAKE_DIR`. Resolve it rather than storing it absolute. */
  path: string;
  /** Decoded contents, for `kind: "text"` only. */
  text: string | null;
  createdAt: string;
}

/**
 * One turn of a board's intake chat: what the user pasted, and what came of it.
 */
export interface IntakeMessage {
  id: string;
  boardId: string;
  /** What the user typed. May be blank when the pasted material speaks for itself. */
  instruction: string;
  /** Pasted text, verbatim — a CSV's line breaks and columns are its content. */
  content: string | null;
  status: IntakeStatus;
  requestedBy: string;
  actorSource: ActorSource;
  attempts: number;
  /** Claude's reply in the chat, or why nothing happened. */
  note: string | null;
  /** Ids of the cards this message produced, so the reply can link them. */
  createdTasks: string[];
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface IntakeMessageWithFiles extends IntakeMessage {
  attachments: IntakeAttachment[];
}

/**
 * A queued message plus everything a run needs to act on it: the board it lands on,
 * that board's window, and each attachment resolved to a path on disk.
 */
export interface IntakeMessageWithContext extends IntakeMessageWithFiles {
  boardName: string;
  boardStartsAt: string;
  boardEndsAt: string;
  boardDurationKind: DurationKind;
  boardDescription: string | null;
  requestedByName: string;
  /**
   * Absolute path per attachment that needs opening. Empty when everything pasted
   * was text — which is what lets the run be given no file access at all.
   */
  readablePaths: Array<{ id: string; filename: string; kind: IntakeAttachmentKind; absolutePath: string }>;
}

/** What the board header needs to show its intake control. */
export interface BoardIntakeSummary {
  /** Messages queued or being worked on. */
  open: number;
  /** True while a run is actually in flight, not merely queued. */
  working: boolean;
  /** Total messages in the conversation, so an empty chat can say so. */
  total: number;
  lastMessageAt: string | null;
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
  /** Watermarks and outstanding request for this board's inbox sync. */
  sync: BoardSyncSummary;
  /**
   * Draft replies outstanding per card. Carried here for the same reason
   * `openMentions` is: a badge that needs its own request per card is a badge
   * that will not be there.
   */
  responses: BoardResponseCount[];
  /** Where this board's intake chat stands, for the header's control. */
  intake: BoardIntakeSummary;
}
