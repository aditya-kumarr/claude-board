import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toSyncRun, toSyncState, type SyncRunRow, type SyncStateRow } from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { parseDate } from "../lib/duration.ts";
import {
  OPEN_SYNC_STATUSES,
  SYNC_SOURCES,
  type BoardSyncState,
  type BoardSyncSummary,
  type DurationKind,
  type SyncRun,
  type SyncRunWithContext,
  type SyncScopeEntry,
  type SyncSource,
  type SyncStatus,
} from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

const log = createLogger("sync");

/**
 * Pulling pending work out of Outlook and Teams onto a board.
 *
 * The API process holds no Microsoft Graph credentials — that access lives in the
 * Microsoft 365 MCP server, which an agent talks to. So a sync is *queued* here
 * rather than performed: the button records a request with a resolved window, an
 * agent run claims it, imports what it finds through the ordinary task tools, and
 * reports back. This module owns the part that has to be right either way — the
 * watermark.
 *
 * The watermark rule is the whole feature: a run scans `(syncedThrough, cutoff]`
 * and only on success does `cutoff` become the new `syncedThrough`. A failed or
 * abandoned run therefore re-reads its window instead of silently skipping a
 * week of mail, and `cutoff` is stamped when the run is *requested* rather than
 * when it finishes, so a message that arrives mid-run is not stepped over.
 */

/** How far back a board with no watermark yet will look. */
const DEFAULT_LOOKBACK_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * The board fields a sync needs, read directly rather than through `getBoard`.
 * `getBoardDetail` embeds the sync summary, so importing the board service here
 * would close an import cycle.
 */
function syncBoard(boardId: string): { id: string; startsAt: string; archived: boolean } {
  const row = getDb()
    .query<{ id: string; starts_at: string; archived: number }, [string]>(
      "SELECT id, starts_at, archived FROM boards WHERE id = ?",
    )
    .get(boardId);
  if (!row) throw notFound("board", boardId);
  return { id: row.id, startsAt: row.starts_at, archived: row.archived === 1 };
}

function requireSource(value: unknown): SyncSource {
  if (typeof value !== "string" || !(SYNC_SOURCES as readonly string[]).includes(value)) {
    throw badRequest(`source must be one of ${SYNC_SOURCES.join(", ")}`, { received: value });
  }
  return value as SyncSource;
}

/** Rows for the sources that have ever been synced, plus blanks for the rest. */
export function getSyncStates(boardId: string): BoardSyncState[] {
  syncBoard(boardId);
  const rows = getDb()
    .query<SyncStateRow, [string]>("SELECT * FROM board_sync_state WHERE board_id = ?")
    .all(boardId);
  const bySource = new Map(rows.map((row) => [row.source, toSyncState(row)]));
  return SYNC_SOURCES.map(
    (source) =>
      bySource.get(source) ?? {
        boardId,
        source,
        syncedThrough: null,
        lastRunAt: null,
        lastStatus: null,
        lastDetail: null,
        imported: 0,
        updatedAt: "",
      },
  );
}

/**
 * Where the next scan of `source` should start.
 *
 * A board that has never synced falls back to its own window start — the board is
 * time-boxed, so its window is the natural scope of "what is pending for this" —
 * clamped to `DEFAULT_LOOKBACK_DAYS` so pointing a Sync button at a year-long
 * board does not try to read a year of mail.
 */
export function resolveSince(
  boardId: string,
  source: SyncSource,
  options: { explicitSince?: string; lookbackDays?: number } = {},
): string {
  const board = syncBoard(boardId);
  const state = getSyncStates(boardId).find((entry) => entry.source === source);

  if (options.explicitSince) return parseDate(options.explicitSince, "since").toISOString();
  if (state?.syncedThrough) return state.syncedThrough;

  const lookbackDays = Math.max(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1);
  const floor = Date.now() - lookbackDays * DAY_MS;
  const boardStart = new Date(board.startsAt).getTime();
  return new Date(Math.max(boardStart, floor)).toISOString();
}

export function getSyncRun(runId: string): SyncRun {
  const row = getDb().query<SyncRunRow, [string]>("SELECT * FROM sync_runs WHERE id = ?").get(runId);
  if (!row) throw notFound("sync run", runId);
  return toSyncRun(row);
}

type SyncRunContextRow = SyncRunRow & {
  board_name: string;
  board_starts_at: string;
  board_ends_at: string;
  board_duration_kind: string;
  board_description: string | null;
};

const CONTEXT_SELECT = /* sql */ `
  SELECT r.*,
         b.name          AS board_name,
         b.starts_at     AS board_starts_at,
         b.ends_at       AS board_ends_at,
         b.duration_kind AS board_duration_kind,
         b.description   AS board_description
    FROM sync_runs r
    JOIN boards b ON b.id = r.board_id
`;

const toContext = (row: SyncRunContextRow): SyncRunWithContext => ({
  ...toSyncRun(row),
  boardName: row.board_name,
  boardStartsAt: row.board_starts_at,
  boardEndsAt: row.board_ends_at,
  boardDurationKind: row.board_duration_kind as DurationKind,
  boardDescription: row.board_description,
});

export interface ListSyncRunsFilter {
  boardId?: string;
  status?: SyncStatus | readonly SyncStatus[];
  /** Oldest first, so a queue is worked in the order it was asked for. */
  oldestFirst?: boolean;
  limit?: number;
}

export function getSyncRunDetail(runId: string): SyncRunWithContext {
  const row = getDb().query<SyncRunContextRow, [string]>(`${CONTEXT_SELECT} WHERE r.id = ?`).get(runId);
  if (!row) throw notFound("sync run", runId);
  return toContext(row);
}

export function listSyncRuns(filter: ListSyncRunsFilter = {}): SyncRunWithContext[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.boardId) {
    where.push("r.board_id = ?");
    params.push(filter.boardId);
  }
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status as SyncStatus];
    if (statuses.length === 0) throw badRequest("status filter cannot be empty");
    where.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
  // By time, not by id. Ids are random strings (`syn_2h4pnw5f`), so ordering by
  // them sorts alphabetically — which silently made "the most recent run" an
  // arbitrary one, and the board's Sync line show a stale result.
  const direction = filter.oldestFirst ? "ASC" : "DESC";
  return getDb()
    .query<SyncRunContextRow, SQLQueryBindings[]>(
      `${CONTEXT_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY datetime(r.created_at) ${direction}, r.rowid ${direction} LIMIT ?`,
    )
    .all(...params, limit)
    .map(toContext);
}

/** Watermarks plus whatever request is outstanding — one read for the UI control. */
export function getSyncSummary(boardId: string): BoardSyncSummary {
  const [activeRun] = listSyncRuns({ boardId, status: OPEN_SYNC_STATUSES, oldestFirst: true, limit: 1 });
  // Ordered by finish time: a run that started earlier can finish later, and it
  // is the latest *result* the board should be reporting.
  const [lastRun] = listSyncRuns({ boardId, status: ["ok", "failed", "cancelled"], limit: 30 }).sort((a, b) =>
    (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt),
  );
  return {
    sources: getSyncStates(boardId),
    activeRun: activeRun ?? null,
    lastRun: lastRun ?? null,
  };
}

export interface RequestSyncInput {
  /** Defaults to every source. */
  sources?: Array<SyncSource | string>;
  /** Override the watermark for this run only; does not change stored state. */
  since?: string;
  lookbackDays?: number;
}

export interface RequestSyncResult {
  run: SyncRun;
  /** True when a request was already outstanding and this call returned that one. */
  alreadyQueued: boolean;
}

/**
 * Queues a sync for a board. Idempotent by design: pressing Sync twice returns
 * the request already in flight rather than stacking a second scan of the same
 * window, which is what a double-tap on a tablet would otherwise do.
 */
export function requestSync(boardId: string, input: RequestSyncInput, actor: ActorContext): RequestSyncResult {
  const board = syncBoard(boardId);
  if (board.archived) throw conflict("cannot sync an archived board", { boardId });

  const existing = listSyncRuns({ boardId, status: OPEN_SYNC_STATUSES, oldestFirst: true, limit: 1 })[0];
  if (existing) return { run: existing, alreadyQueued: true };

  const requested = input.sources?.length ? input.sources.map(requireSource) : [...SYNC_SOURCES];
  const sources = [...new Set(requested)];

  const scope: SyncScopeEntry[] = sources.map((source) => ({
    source,
    since: resolveSince(boardId, source, { explicitSince: input.since, lookbackDays: input.lookbackDays }),
  }));
  // Stamped now, not at completion: anything arriving while the run is in flight
  // stays above the watermark and is picked up next time rather than skipped.
  const cutoff = new Date().toISOString();
  const since = scope.reduce((earliest, entry) => (entry.since < earliest ? entry.since : earliest), cutoff);

  const id = newId("syn");
  write((db) => {
    db.run(
      `INSERT INTO sync_runs (id, board_id, scope, status, requested_by, actor_source, since, cutoff, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [id, boardId, JSON.stringify(scope), actor.actorId, actor.source, since, cutoff, cutoff],
    );
    record(db, actor, "sync.requested", { boardId }, {
      runId: id,
      sources,
      since,
      cutoff,
    });
  });

  log.info("sync requested", {
    runId: id,
    boardId,
    sources,
    since,
    cutoff,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { run: getSyncRun(id), alreadyQueued: false };
}

/**
 * Takes a queued sync. Like claiming a mention, the read and the write share one
 * transaction so two runners racing for the same request cannot both win.
 */
export function claimSyncRun(runId: string, actor: ActorContext): SyncRunWithContext {
  const before = getSyncRun(runId);
  write((db) => {
    const current = db.query<{ status: string }, [string]>("SELECT status FROM sync_runs WHERE id = ?").get(runId);
    if (!current) throw notFound("sync run", runId);
    if (current.status !== "pending") {
      throw conflict(`sync run ${runId} is ${current.status}, not pending`, { runId, status: current.status });
    }
    db.run("UPDATE sync_runs SET status = 'running', started_at = ? WHERE id = ?", [
      new Date().toISOString(),
      runId,
    ]);
    record(db, actor, "sync.claimed", { boardId: before.boardId }, { runId });
  });

  log.info("sync claimed", { runId, boardId: before.boardId, actor: actor.actorId, source: actor.source });
  return getSyncRunDetail(runId);
}

export interface CompleteSyncInput {
  /**
   * Outcome for the run as a whole. Ignored for a source that names its own in
   * `sourceStatus`.
   */
  status?: Extract<SyncStatus, "ok" | "failed">;
  /**
   * Per-source outcome, for the common case where one inbox was read fully and
   * another was not — Graph throttles Teams far more readily than mail. Only the
   * sources marked `ok` advance their watermark, so the half that failed is
   * re-read next run while the half that succeeded is not re-scanned.
   */
  sourceStatus?: Partial<Record<SyncSource, Extract<SyncStatus, "ok" | "failed">>>;
  /**
   * Cards created, per source — `{ outlook: 2, teams: 0 }`. A bare number is
   * accepted only when the run scanned a single source; spreading one total
   * across several would credit Teams for mail that came out of Outlook.
   */
  imported?: number | Partial<Record<SyncSource, number>>;
  /** What was found and what was skipped. Shown as "last synced" detail. */
  detail: string;
}

/** Resolves the `imported` input into one count per source in the run's scope. */
function attributeImported(
  scope: SyncScopeEntry[],
  imported: CompleteSyncInput["imported"],
): { perSource: Map<SyncSource, number>; total: number } {
  const perSource = new Map<SyncSource, number>(scope.map((entry) => [entry.source, 0]));

  if (typeof imported === "number") {
    const count = Math.max(Math.trunc(imported), 0);
    if (count > 0) {
      if (scope.length !== 1) {
        throw badRequest(
          "this run scanned more than one source, so imported must name them, e.g. { outlook: 2, teams: 0 }",
          { sources: scope.map((entry) => entry.source), received: imported },
        );
      }
      perSource.set(scope[0]!.source, count);
    }
  } else if (imported) {
    for (const [key, value] of Object.entries(imported)) {
      const source = requireSource(key);
      if (!perSource.has(source)) {
        throw badRequest(`this run did not scan ${source}`, {
          sources: scope.map((entry) => entry.source),
        });
      }
      perSource.set(source, Math.max(Math.trunc(value ?? 0), 0));
    }
  }

  let total = 0;
  for (const count of perSource.values()) total += count;
  return { perSource, total };
}

/**
 * Closes out a run and, only on success, advances the watermark for every source
 * it was asked to scan. Failing without moving the watermark is the point: the
 * next run re-reads the same window rather than leaving a hole in the history.
 */
export function completeSyncRun(runId: string, input: CompleteSyncInput, actor: ActorContext): SyncRun {
  const run = getSyncRun(runId);
  const status = input.status ?? "ok";
  if (status !== "ok" && status !== "failed") {
    throw badRequest("status must be ok or failed", { received: status });
  }
  if (run.status === "ok" || run.status === "failed" || run.status === "cancelled") {
    throw conflict(`sync run ${runId} is already ${run.status}`, { runId, status: run.status, detail: run.detail });
  }
  const detail = input.detail?.trim();
  if (!detail) throw badRequest("detail is required — say what the sync found");
  if (detail.length > 2000) throw badRequest("detail must be 2000 characters or fewer");
  const { perSource, total } = attributeImported(run.scope, input.imported);

  // Resolve each scanned source's own outcome, defaulting to the run's.
  const statusBySource = new Map<SyncSource, "ok" | "failed">();
  for (const entry of run.scope) {
    const named = input.sourceStatus?.[entry.source];
    if (named !== undefined && named !== "ok" && named !== "failed") {
      throw badRequest(`sourceStatus.${entry.source} must be ok or failed`, { received: named });
    }
    statusBySource.set(entry.source, named ?? status);
  }
  for (const key of Object.keys(input.sourceStatus ?? {})) {
    if (!statusBySource.has(requireSource(key))) {
      throw badRequest(`this run did not scan ${key}`, { sources: run.scope.map((entry) => entry.source) });
    }
  }
  // The run reads as successful only if every source it took on succeeded — a
  // partial read must not look complete in the history.
  const overall: "ok" | "failed" = [...statusBySource.values()].every((value) => value === "ok") ? "ok" : "failed";

  const finishedAt = new Date().toISOString();
  write((db) => {
    db.run("UPDATE sync_runs SET status = ?, imported = ?, detail = ?, finished_at = ? WHERE id = ?", [
      overall,
      total,
      detail,
      finishedAt,
      runId,
    ]);

    for (const entry of run.scope) {
      db.run(
        `INSERT INTO board_sync_state (board_id, source, synced_through, last_run_at, last_status, last_detail, imported, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (board_id, source) DO UPDATE SET
           -- Only a successful run may move the watermark.
           synced_through = CASE WHEN excluded.last_status = 'ok' THEN excluded.synced_through ELSE synced_through END,
           last_run_at    = excluded.last_run_at,
           last_status    = excluded.last_status,
           last_detail    = excluded.last_detail,
           imported       = imported + excluded.imported,
           updated_at     = excluded.updated_at`,
        [
          run.boardId,
          entry.source,
          statusBySource.get(entry.source) === "ok" ? run.cutoff : null,
          finishedAt,
          statusBySource.get(entry.source)!,
          detail,
          statusBySource.get(entry.source) === "ok" ? (perSource.get(entry.source) ?? 0) : 0,
          finishedAt,
        ],
      );
    }

    record(db, actor, "sync.completed", { boardId: run.boardId }, {
      runId,
      status: overall,
      sourceStatus: Object.fromEntries(statusBySource),
      imported: Object.fromEntries(perSource),
      detail,
      advanced: [...statusBySource.entries()].filter(([, value]) => value === "ok").map(([key]) => key),
    });
  });

  log[overall === "ok" ? "info" : "warn"]("sync completed", {
    runId,
    boardId: run.boardId,
    status: overall,
    sourceStatus: Object.fromEntries(statusBySource),
    imported: Object.fromEntries(perSource),
    total,
    cutoff: run.cutoff,
    actor: actor.actorId,
    source: actor.source,
  });
  return getSyncRun(runId);
}

/**
 * Abandons a queued or running sync without touching the watermark. Used when a
 * run dies, so the board is not stuck showing "syncing" forever.
 */
export function cancelSyncRun(runId: string, reason: string, actor: ActorContext): SyncRun {
  const run = getSyncRun(runId);
  if (!OPEN_SYNC_STATUSES.includes(run.status)) {
    throw conflict(`sync run ${runId} is already ${run.status}`, { runId, status: run.status });
  }
  write((db) => {
    db.run("UPDATE sync_runs SET status = 'cancelled', detail = ?, finished_at = ? WHERE id = ?", [
      reason.trim() || "cancelled",
      new Date().toISOString(),
      runId,
    ]);
    record(db, actor, "sync.cancelled", { boardId: run.boardId }, { runId, reason });
  });
  log.warn("sync cancelled", { runId, boardId: run.boardId, reason, actor: actor.actorId });
  return getSyncRun(runId);
}
