import type {
  ActivityEntry,
  BoardColumn,
  BoardDetail,
  BoardSyncSummary,
  ColumnKind,
  DurationKind,
  Mention,
  MentionStatus,
  MentionWithContext,
  Priority,
  SyncRun,
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
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  column?: string;
  assignee?: string | null;
  priority?: Priority;
  dueAt?: string | null;
}

export const api = {
  health: () => request<{ ok: boolean; revision: number; logFile: string; database: string }>("/health"),
  revision: () => request<{ revision: number }>("/meta/revision"),
  users: () => request<{ users: User[] }>("/users"),

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
   */
  requestSync: (boardId: string, payload: { sources?: SyncSource[]; since?: string; lookbackDays?: number } = {}) =>
    request<{ run: SyncRun; alreadyQueued: boolean }>(`/boards/${boardId}/sync`, {
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
  mentions: (taskId: string, status?: MentionStatus) =>
    request<{ mentions: MentionWithContext[] }>(
      `/tasks/${taskId}/mentions${status ? `?status=${status}` : ""}`,
    ),
};
