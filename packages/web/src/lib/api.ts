import type {
  ActivityEntry,
  BoardIntakeSummary,
  IntakeMessageWithFiles,
  IntakeRejection,
  BoardColumn,
  BoardDetail,
  BoardSyncSummary,
  ColumnKind,
  DurationKind,
  Mention,
  MentionStatus,
  MentionWithContext,
  Priority,
  Project,
  ResponseStage,
  ResponseStatus,
  ResponseTurnWithContext,
  ResponseWithContext,
  SyncRun,
  SyncSkip,
  TaskResponse,
  TaskResponseSummary,
  SyncSource,
  Task,
  TaskComment,
  TaskDetail,
  TaskWithContext,
  User,
} from "./types";

/** Error carrying the server's machine-readable code so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      // Everything from this UI is attributed to the human.
      "x-actor": "me",
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `Request failed with ${response.status}`,
      error?.details,
    );
  }
  return payload as T;
}

const body = (data: unknown) => ({ body: JSON.stringify(data) });

export interface CreateBoardPayload {
  name: string;
  durationKind: DurationKind;
  description?: string;
  anchor?: string;
  endsAt?: string;
  columns?: string[];
  /** Project id, slug, name or path. The default for every card on the board. */
  project?: string | null;
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  column?: string;
  assignee?: string | null;
  priority?: Priority;
  dueAt?: string | null;
  /** Overrides the board's project. `null` clears the override, it does not unset one. */
  project?: string | null;
}

export interface ProjectPayload {
  name: string;
  /** Absolute path, or one starting with `~`. Checked server-side before it is stored. */
  path: string;
  description?: string | null;
}

export const api = {
  health: () => request<{ ok: boolean; revision: number; logFile: string; database: string }>("/health"),
  revision: () => request<{ revision: number }>("/meta/revision"),
  users: () => request<{ users: User[] }>("/users"),

  /* ---- projects ----
   * Directories on the machine running the API, not on the machine running this
   * browser: the path is validated there, which is why an invalid one comes back
   * as a 400 rather than being caught in the form.
   */
  listProjects: (includeArchived = false) =>
    request<{ projects: Project[] }>(`/projects?includeArchived=${includeArchived}`),
  createProject: (payload: ProjectPayload) => request<Project>("/projects", { method: "POST", ...body(payload) }),
  updateProject: (projectId: string, patch: Partial<ProjectPayload> & { archived?: boolean }) =>
    request<Project>(`/projects/${projectId}`, { method: "PATCH", ...body(patch) }),
  /** Unregisters the directory. Nothing on disk is touched; cards are detached. */
  deleteProject: (projectId: string) =>
    request<{ id: string; detachedBoards: number; detachedTasks: number }>(`/projects/${projectId}`, {
      method: "DELETE",
    }),

  listBoards: (includeArchived = false) =>
    request<{ boards: BoardDetail[] }>(`/boards?includeArchived=${includeArchived}`),
  getBoard: (boardId: string) => request<BoardDetail>(`/boards/${boardId}`),
  createBoard: (payload: CreateBoardPayload) => request<BoardDetail>("/boards", { method: "POST", ...body(payload) }),
  updateBoard: (boardId: string, patch: Partial<CreateBoardPayload> & { archived?: boolean }) =>
    request<BoardDetail>(`/boards/${boardId}`, { method: "PATCH", ...body(patch) }),
  deleteBoard: (boardId: string) =>
    request<{ id: string; deletedTasks: number }>(`/boards/${boardId}`, { method: "DELETE" }),
  boardActivity: (boardId: string, limit = 40) =>
    request<{ activity: ActivityEntry[] }>(`/boards/${boardId}/activity?limit=${limit}`),

  /**
   * Queues a sync — it does not perform one. The API cannot reach Microsoft
   * Graph; an agent run picks the request up. `alreadyQueued` means a request was
   * outstanding and this call returned that one instead of stacking a second.
   *
   * `skipped` names sources left out because they are resting — Teams is read at
   * most every couple of hours, and longer after a rate limit. Show it: a sync
   * that quietly dropped Teams looks just like one that read it and found nothing.
   */
  requestSync: (
    boardId: string,
    payload: { sources?: SyncSource[]; since?: string; lookbackDays?: number; force?: boolean } = {},
  ) =>
    request<{ run: SyncRun; alreadyQueued: boolean; skipped: SyncSkip[] }>(`/boards/${boardId}/sync`, {
      method: "POST",
      ...body(payload),
    }),
  /** Drops the outstanding request, so a queue nothing is listening to can be cleared. */
  cancelSync: (boardId: string, reason?: string) =>
    request<SyncRun>(`/boards/${boardId}/sync`, { method: "DELETE", ...body({ reason }) }),
  syncState: (boardId: string, limit = 10) =>
    request<BoardSyncSummary & { runs: SyncRun[] }>(`/boards/${boardId}/sync?limit=${limit}`),

  addColumn: (boardId: string, payload: { name: string; kind?: ColumnKind; position?: number; wipLimit?: number | null }) =>
    request<BoardColumn>(`/boards/${boardId}/columns`, { method: "POST", ...body(payload) }),
  updateColumn: (
    boardId: string,
    columnId: string,
    patch: { name?: string; kind?: ColumnKind; position?: number; wipLimit?: number | null },
  ) => request<BoardColumn>(`/boards/${boardId}/columns/${columnId}`, { method: "PATCH", ...body(patch) }),
  deleteColumn: (boardId: string, columnId: string, moveTasksTo?: string) =>
    request<{ movedTasks: number; movedTo: string | null }>(
      `/boards/${boardId}/columns/${columnId}${moveTasksTo ? `?moveTasksTo=${encodeURIComponent(moveTasksTo)}` : ""}`,
      { method: "DELETE" },
    ),

  createTask: (boardId: string, payload: CreateTaskPayload) =>
    request<Task>(`/boards/${boardId}/tasks`, { method: "POST", ...body(payload) }),
  getTask: (taskId: string) => request<TaskDetail>(`/tasks/${taskId}`),
  updateTask: (taskId: string, patch: Partial<CreateTaskPayload> & { blockedReason?: string | null }) =>
    request<Task>(`/tasks/${taskId}`, { method: "PATCH", ...body(patch) }),
  moveTask: (taskId: string, payload: { column: string; index?: number; blockedReason?: string | null; force?: boolean }) =>
    request<Task>(`/tasks/${taskId}/move`, { method: "POST", ...body(payload) }),
  deleteTask: (taskId: string) => request<{ id: string }>(`/tasks/${taskId}`, { method: "DELETE" }),

  listTasks: (params: Record<string, string | boolean | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<{ tasks: TaskWithContext[] }>(`/tasks?${query.toString()}`);
  },

  comments: (taskId: string) => request<{ comments: TaskComment[] }>(`/tasks/${taskId}/comments`),
  /**
   * The response carries any `@claude` the comment raised, so the UI can confirm
   * the request registered instead of leaving the user to infer it from a
   * highlighted word.
   */
  addComment: (taskId: string, text: string) =>
    request<TaskComment & { mentions: Mention[] }>(`/tasks/${taskId}/comments`, {
      method: "POST",
      ...body({ body: text }),
    }),
  /* ---- the board's intake chat ----
   * Posting only queues: this process has no model access, so `202` with a pending
   * message is the honest answer and the cards arrive on the revision poll.
   * Attachments travel as base64 inside the JSON, which keeps the server free of a
   * multipart dependency for a handful of files.
   */
  intake: (boardId: string, limit = 100) =>
    request<{ messages: IntakeMessageWithFiles[]; summary: BoardIntakeSummary }>(
      `/boards/${boardId}/intake?limit=${limit}`,
    ),
  postIntake: (
    boardId: string,
    payload: {
      instruction?: string;
      content?: string | null;
      attachments?: Array<{ filename: string; mime?: string; data: string }>;
    },
  ) =>
    request<{ message: IntakeMessageWithFiles; rejected: IntakeRejection[] }>(`/boards/${boardId}/intake`, {
      method: "POST",
      ...body(payload),
    }),
  /** Drops whatever is queued, so a dead run cannot wedge the composer. */
  cancelIntake: (boardId: string, reason?: string) =>
    request<IntakeMessageWithFiles>(`/boards/${boardId}/intake/pending`, { method: "DELETE", ...body({ reason }) }),
  deleteIntakeMessage: (messageId: string) =>
    request<{ id: string }>(`/intake/messages/${messageId}`, { method: "DELETE" }),
  /** Direct URL, for an `<img>` or a link — not fetched through `request`. */
  attachmentUrl: (attachmentId: string) => `/api/intake/attachments/${attachmentId}/content`,

  /* ---- draft replies ----
   * A card imported from a mail is half a card without the message the user owes
   * back. Two of these only *queue* work: asking Claude to rewrite a draft, and
   * asking for a card's first drafts, both need a model this process cannot reach,
   * so they answer 202 and the result arrives on the revision poll. There is no
   * send endpoint on purpose — `setResponseStatus(id, "sent")` records that the
   * user sent it themselves.
   */
  taskResponses: (taskId: string) => request<TaskResponseSummary>(`/tasks/${taskId}/responses`),
  /** Queues a first drafting pass, for a card a sync did not write replies for. */
  requestDrafts: (taskId: string, instruction?: string) =>
    request<{ turn: ResponseTurnWithContext; alreadyQueued: boolean }>(`/tasks/${taskId}/responses/draft`, {
      method: "POST",
      ...body({ instruction }),
    }),
  cancelDrafts: (taskId: string, reason?: string) =>
    request<ResponseTurnWithContext>(`/tasks/${taskId}/responses/draft`, { method: "DELETE", ...body({ reason }) }),

  getResponse: (responseId: string) => request<ResponseWithContext>(`/responses/${responseId}`),
  /** Hand edits. Content only; status moves through its own route. */
  updateResponse: (
    responseId: string,
    patch: {
      body?: string;
      subject?: string | null;
      recipientName?: string;
      recipientRef?: string | null;
      cc?: string[];
      stage?: ResponseStage;
    },
  ) => request<TaskResponse>(`/responses/${responseId}`, { method: "PATCH", ...body(patch) }),
  setResponseStatus: (responseId: string, status: ResponseStatus) =>
    request<TaskResponse>(`/responses/${responseId}/status`, { method: "POST", ...body({ status }) }),
  /** Queues a rewrite. `alreadyQueued` means one was already in flight. */
  reviseResponse: (responseId: string, instruction: string) =>
    request<{ turn: ResponseTurnWithContext; alreadyQueued: boolean }>(`/responses/${responseId}/revise`, {
      method: "POST",
      ...body({ instruction }),
    }),
  cancelRevision: (responseId: string, reason?: string) =>
    request<ResponseTurnWithContext>(`/responses/${responseId}/turn`, { method: "DELETE", ...body({ reason }) }),
  deleteResponse: (responseId: string) => request<{ id: string }>(`/responses/${responseId}`, { method: "DELETE" }),

  mentions: (taskId: string, status?: MentionStatus) =>
    request<{ mentions: MentionWithContext[] }>(
      `/tasks/${taskId}/mentions${status ? `?status=${status}` : ""}`,
    ),
};
