import type { SQLQueryBindings } from "bun:sqlite";
import { getDb, write } from "../db/index.ts";
import { toSyncRun, toSyncState, type SyncRunRow, type SyncStateRow } from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import { parseDate } from "../lib/duration.ts";
import {
  OPEN_SYNC_STATUSES,
  SYNC_SOURCE_OUTCOMES,
  SYNC_SOURCES,
  type BoardSyncState,
  type BoardSyncSummary,
  type DurationKind,
  type SyncRun,
  type SyncRunWithContext,
  type SyncScopeEntry,
  type SyncSkip,
  type SyncSourceOutcome,
  type SyncSource,
  type SyncSourceProgress,
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
const MINUTE_MS = 60_000;

const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const envDays = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? value : fallback;
};

/**
 * What each source costs to read, expressed as how often it is worth reading.
 *
 * Outlook has a real server-side search: one filtered query, paged, cheap enough
 * that scanning it on every press of the button is free. Teams does not — see the
 * note on `board_sync_state.cooldown_until` — so a Teams scan is ~50 Graph calls
 * that cost the same however narrow the window, and pressing Sync three times in
 * a row is three of them into the same rate limit.
 *
 * So the two sources are not read on the same cadence. `minIntervalMs` is the
 * floor between *attempts* at a source, which is what makes repeated presses of
 * one button safe; `maxLookbackDays` caps how wide a window is ever requested,
 * which stops a repeatedly-throttled source's window growing without bound and
 * keeps the ask inside what the connector can actually return.
 */
const SOURCE_POLICY: Record<
  SyncSource,
  { minIntervalMs: number; maxLookbackDays: number; batchLimit: number }
> = {
  outlook: {
    minIntervalMs: envMs("SYNC_OUTLOOK_MIN_INTERVAL_MS", 0),
    maxLookbackDays: envDays("SYNC_OUTLOOK_MAX_LOOKBACK_DAYS", 14),
    // Outlook has a real server-side search: one filtered query, paged. There is
    // nothing to batch, so no limit.
    batchLimit: Number(process.env.SYNC_OUTLOOK_BATCH_LIMIT ?? 0),
  },
  teams: {
    minIntervalMs: envMs("SYNC_TEAMS_MIN_INTERVAL_MS", 2 * 60 * MINUTE_MS),
    maxLookbackDays: envDays("SYNC_TEAMS_MAX_LOOKBACK_DAYS", 3),
    /**
     * Chats per run. The reason a Teams scan gets throttled is that it visits
     * every chat in one go; a bounded batch is the only mitigation, since
     * narrowing the *window* does not reduce how many chats are walked. Cards
     * from each batch land immediately, so the newest threads become tasks on the
     * first run rather than after the whole sweep finishes.
     */
    batchLimit: Math.max(Number(process.env.SYNC_TEAMS_BATCH_LIMIT ?? 10), 1),
  },
};

/**
 * How long a source rests after a run reports it was throttled. Longer than the
 * ordinary interval: a 429 says the budget is already spent, so the next attempt
 * would buy nothing.
 */
const THROTTLE_COOLDOWN_MS = envMs("SYNC_THROTTLE_COOLDOWN_MS", 30 * MINUTE_MS);

/**
 * Whether some text is a rate limit rather than a real failure. Lives here so
 * the watcher and the completion path agree on what counts — a run that says
 * "429" in its detail but forgets `sourceStatus: throttled` should still earn the
 * cooldown, or the next press walks straight back into the wall.
 */
export const looksThrottled = (text: string | null | undefined): boolean =>
  /429|throttl|rate.?limit|too many requests/i.test(text ?? "");

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
        cooldownUntil: null,
        progress: null,
        updatedAt: "",
      },
  );
}

export interface ResolveSinceOptions {
  explicitSince?: string;
  lookbackDays?: number;
}

/**
 * Where the next scan of `source` should start, and whether that skipped past a
 * watermark to get there.
 *
 * A board that has never synced falls back to its own window start — the board is
 * time-boxed, so its window is the natural scope of "what is pending for this" —
 * clamped to `DEFAULT_LOOKBACK_DAYS` so pointing a Sync button at a year-long
 * board does not try to read a year of mail.
 *
 * A *stored* watermark is then clamped too, by the source's `maxLookbackDays`.
 * That is the one place this deliberately gives up completeness, so it is worth
 * being plain about why: a source that keeps failing never advances its
 * watermark, so its window widens every day, and for Teams a wider window is not
 * merely slower — the connector answers a date-filtered chat search by walking
 * the most recent messages of each chat, so messages older than that are
 * unreachable no matter what `since` says. Asking for them anyway buys a run that
 * cannot succeed and a window that grows for ever. The clamp is reported through
 * `cappedFrom` rather than made quietly, because a skipped span is a real gap.
 */
export function resolveScopeEntry(
  boardId: string,
  source: SyncSource,
  options: ResolveSinceOptions = {},
): SyncScopeEntry {
  const board = syncBoard(boardId);
  const state = getSyncStates(boardId).find((entry) => entry.source === source);
  const batchLimit = SOURCE_POLICY[source].batchLimit || undefined;

  // An explicit window is the caller overriding the policy on purpose; honour it,
  // and treat it as starting a fresh pass rather than resuming a stale one.
  if (options.explicitSince) {
    return { source, since: parseDate(options.explicitSince, "since").toISOString(), batchLimit };
  }

  // A pass already under way continues on its own frozen terms: same start, same
  // cutoff, minus the items already read. Re-resolving the window here would move
  // the end of a window the earlier batches were measured against.
  if (state?.progress) {
    return {
      source,
      // Both ends come from the pass, not from stored state: the watermark has
      // deliberately not moved, so it cannot say where this pass began.
      since: state.progress.passSince,
      cutoff: state.progress.passCutoff,
      batchLimit,
      resumeFrom: state.progress,
    };
  }

  if (state?.syncedThrough) {
    const cap = Date.now() - SOURCE_POLICY[source].maxLookbackDays * DAY_MS;
    if (new Date(state.syncedThrough).getTime() >= cap) {
      return { source, since: state.syncedThrough, batchLimit };
    }
    return { source, since: new Date(cap).toISOString(), cappedFrom: state.syncedThrough, batchLimit };
  }

  const lookbackDays = Math.min(
    Math.max(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1),
    SOURCE_POLICY[source].maxLookbackDays,
  );
  const floor = Date.now() - lookbackDays * DAY_MS;
  const boardStart = new Date(board.startsAt).getTime();
  return { source, since: new Date(Math.max(boardStart, floor)).toISOString(), batchLimit };
}

/** This source's window end for a given run: its own if it froze one, else the run's. */
export const scopeCutoff = (run: Pick<SyncRun, "cutoff">, entry: SyncScopeEntry): string =>
  entry.cutoff ?? run.cutoff;

/** The start of the next scan of `source`. See `resolveScopeEntry` for the rest. */
export function resolveSince(boardId: string, source: SyncSource, options: ResolveSinceOptions = {}): string {
  return resolveScopeEntry(boardId, source, options).since;
}

/**
 * Whether `source` may be scanned now, and if not, when.
 *
 * Two reasons to wait, kept apart because they read differently to a user: a
 * `cooldown` is this source having been throttled, and an `interval` is it simply
 * having been read recently enough that reading it again would spend a Graph
 * budget to learn nothing.
 */
function eligibility(state: BoardSyncState): SyncSkip | null {
  const now = Date.now();

  if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) {
    return {
      source: state.source,
      reason: "cooldown",
      nextEligibleAt: state.cooldownUntil,
      detail: `${state.source} was throttled by Microsoft Graph and is resting until ${state.cooldownUntil}`,
    };
  }

  // Finishing a pass already started is a different act from beginning one. The
  // interval exists because a *full* Teams scan is ~50 Graph calls; the next
  // batch of a pass in flight is a fraction of that, and making it wait two hours
  // would turn one sweep into a day. A real throttle above still applies.
  if (state.progress) return null;

  const { minIntervalMs } = SOURCE_POLICY[state.source];
  if (minIntervalMs > 0 && state.lastRunAt) {
    const nextAt = new Date(state.lastRunAt).getTime() + minIntervalMs;
    if (nextAt > now) {
      return {
        source: state.source,
        reason: "interval",
        nextEligibleAt: new Date(nextAt).toISOString(),
        detail:
          `${state.source} was last read at ${state.lastRunAt}; it is scanned at most every ` +
          `${Math.round(minIntervalMs / MINUTE_MS)} min because each scan costs ~50 Graph calls`,
      };
    }
  }

  return null;
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
  const sources = getSyncStates(boardId);
  return {
    sources,
    activeRun: activeRun ?? null,
    lastRun: lastRun ?? null,
    // Same `eligibility` the request path uses, so the panel and the button can
    // never disagree about what a press would actually do.
    skips: sources.map(eligibility).filter((skip): skip is SyncSkip => skip !== null),
  };
}

export interface RequestSyncInput {
  /** Defaults to every source. */
  sources?: Array<SyncSource | string>;
  /** Override the watermark for this run only; does not change stored state. */
  since?: string;
  lookbackDays?: number;
  /**
   * Scan a source even if it is resting. The escape hatch for "read Teams now
   * anyway" — deliberate, and not what the button does, because the resting is
   * the whole mechanism that keeps a repeated press off the rate limit.
   */
  force?: boolean;
}

export interface RequestSyncResult {
  run: SyncRun;
  /** True when a request was already outstanding and this call returned that one. */
  alreadyQueued: boolean;
  /**
   * Sources deliberately left out of this run and when they come back. Never
   * silent: a Sync that quietly skipped Teams is indistinguishable from one that
   * read it and found nothing.
   */
  skipped: SyncSkip[];
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
  if (existing) return { run: existing, alreadyQueued: true, skipped: [] };

  const requested = input.sources?.length ? input.sources.map(requireSource) : [...SYNC_SOURCES];
  const asked = [...new Set(requested)];

  // Drop the sources that are resting before resolving windows, so a run is
  // never queued for work it should not do. Outlook has no interval and is only
  // ever held back by an actual throttle, so the ordinary press still reads mail.
  const states = new Map(getSyncStates(boardId).map((state) => [state.source, state]));
  const skipped: SyncSkip[] = [];
  const sources: SyncSource[] = [];
  for (const source of asked) {
    const skip = input.force ? null : eligibility(states.get(source)!);
    if (skip) skipped.push(skip);
    else sources.push(source);
  }

  if (sources.length === 0) {
    throw conflict(
      `nothing to scan: ${skipped.map((entry) => entry.detail).join("; ")}`,
      { boardId, skipped, retryAfter: skipped.map((entry) => entry.nextEligibleAt).sort()[0] },
    );
  }

  const scope: SyncScopeEntry[] = sources.map((source) =>
    resolveScopeEntry(boardId, source, { explicitSince: input.since, lookbackDays: input.lookbackDays }),
  );
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
      skipped: skipped.map((entry) => ({ source: entry.source, reason: entry.reason })),
      capped: scope.filter((entry) => entry.cappedFrom).map((entry) => entry.source),
    });
  });

  log.info("sync requested", {
    runId: id,
    boardId,
    sources,
    skipped,
    since,
    cutoff,
    actor: actor.actorId,
    source: actor.source,
    requestId: actor.requestId,
  });
  return { run: getSyncRun(id), alreadyQueued: false, skipped };
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

/**
 * The `progress` column's next value for one source.
 *
 * `ok` clears it: the pass is done and the watermark has moved, so resume state
 * would only mislead the next run. A source still working through a pass keeps
 * it, merging this run's keys into what earlier batches recorded. A hard failure
 * keeps whatever was there rather than discarding a pass's accumulated work over
 * one bad run.
 */
function nextProgress(
  entry: SyncScopeEntry,
  cutoff: string,
  outcome: SyncSourceOutcome,
  reported: { doneKeys?: string[]; total?: number | null; cursor?: string | null } | undefined,
): string | null {
  if (outcome === "ok") return null;

  const carried = entry.resumeFrom;
  const merged = [...new Set([...(carried?.doneKeys ?? []), ...(reported?.doneKeys ?? [])])];
  if (merged.length === 0 && reported === undefined) {
    // Nothing new and nothing carried: leave the column as it was.
    return carried ? JSON.stringify(carried) : null;
  }

  const progress: SyncSourceProgress = {
    // The pass keeps the window it started with, even across a failure.
    passSince: carried?.passSince ?? entry.since,
    passCutoff: carried?.passCutoff ?? cutoff,
    // Bounded so a pathological pass cannot grow the row without limit; the
    // oldest keys are the likeliest to have been re-read harmlessly anyway.
    doneKeys: merged.slice(-500),
    scanned: Math.min(merged.length, 500),
    total: reported?.total ?? carried?.total ?? null,
    cursor: reported?.cursor ?? carried?.cursor ?? null,
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(progress);
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
   *
   * `throttled` is `failed` plus a reason: the watermark is held back exactly the
   * same way, and the source additionally rests for `SYNC_THROTTLE_COOLDOWN_MS`
   * so the next press does not spend a fresh budget on the same wall. Say it
   * whenever Graph returned a 429 or the connector reported partial results.
   */
  sourceStatus?: Partial<Record<SyncSource, SyncSourceOutcome>>;
  /**
   * Cards created, per source — `{ outlook: 2, teams: 0 }`. A bare number is
   * accepted only when the run scanned a single source; spreading one total
   * across several would credit Teams for mail that came out of Outlook.
   */
  imported?: number | Partial<Record<SyncSource, number>>;
  /**
   * What each source got through, for a source reporting `partial`. `doneKeys`
   * are the provider ids fully read *this run*; they are merged with what earlier
   * batches recorded, so a run only has to report its own work.
   */
  sourceProgress?: Partial<
    Record<SyncSource, { doneKeys?: string[]; total?: number | null; cursor?: string | null }>
  >;
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
  const outcomeBySource = new Map<SyncSource, SyncSourceOutcome>();
  for (const entry of run.scope) {
    const named = input.sourceStatus?.[entry.source];
    if (named !== undefined && !SYNC_SOURCE_OUTCOMES.includes(named)) {
      throw badRequest(`sourceStatus.${entry.source} must be one of ${SYNC_SOURCE_OUTCOMES.join(", ")}`, {
        received: named,
      });
    }
    // A run that describes a 429 in its detail but reports a plain `failed` still
    // means the budget is spent. Believe the description: the cost of missing it
    // is the next press walking into the same limit.
    const inferred = named ?? status;
    // Attributable only when there is no doubt which source it was: a run that
    // scanned one thing, or a detail that names this one. Guessing on a two-source
    // run would rest Outlook for a limit Teams hit.
    const attributable = run.scope.length === 1 || detail.toLowerCase().includes(entry.source);
    // A batch that stopped *because* of a limit still spent the budget, so a
    // `partial` describing a 429 earns the rest too — while keeping its progress,
    // since the items it did read were read.
    outcomeBySource.set(
      entry.source,
      (inferred === "failed" || inferred === "partial") && attributable && looksThrottled(detail)
        ? "throttled"
        : inferred,
    );
  }
  for (const key of Object.keys(input.sourceStatus ?? {})) {
    if (!outcomeBySource.has(requireSource(key))) {
      throw badRequest(`this run did not scan ${key}`, { sources: run.scope.map((entry) => entry.source) });
    }
  }
  // `throttled` is a failure with a reason attached, so it lands the same way
  // everywhere the watermark is concerned. `partial` also holds the watermark,
  // but it is stored as `failed` only because the column predates it — callers
  // tell a mid-pass source from a broken one by `progress` being set, not by this.
  const statusBySource = new Map<SyncSource, "ok" | "failed">(
    [...outcomeBySource].map(([source, outcome]) => [source, outcome === "ok" ? "ok" : "failed"]),
  );
  // A run is a failure only if something actually went wrong. A source that read
  // its batch cleanly and has more to go did exactly what it was asked, so the
  // run reads as successful and the remaining work shows as progress, not as an
  // error the user has to interpret.
  const broke = [...outcomeBySource.values()].some((value) => value === "failed" || value === "throttled");
  const overall: "ok" | "failed" = broke ? "failed" : "ok";

  const finishedAt = new Date().toISOString();
  const cooldownUntil = new Date(Date.now() + THROTTLE_COOLDOWN_MS).toISOString();
  write((db) => {
    db.run("UPDATE sync_runs SET status = ?, imported = ?, detail = ?, finished_at = ? WHERE id = ?", [
      overall,
      total,
      detail,
      finishedAt,
      runId,
    ]);

    for (const entry of run.scope) {
      const outcome = outcomeBySource.get(entry.source)!;
      const cutoff = scopeCutoff(run, entry);
      db.run(
        `INSERT INTO board_sync_state (board_id, source, synced_through, last_run_at, last_status, last_detail, imported, cooldown_until, progress, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (board_id, source) DO UPDATE SET
           -- Only a successful run may move the watermark.
           synced_through = CASE WHEN excluded.last_status = 'ok' THEN excluded.synced_through ELSE synced_through END,
           last_run_at    = excluded.last_run_at,
           last_status    = excluded.last_status,
           last_detail    = excluded.last_detail,
           imported       = imported + excluded.imported,
           -- A throttle sets the rest; anything else clears it, so a source that
           -- read cleanly is immediately available again rather than serving out
           -- a penalty for a limit that has plainly lifted.
           cooldown_until = excluded.cooldown_until,
           -- Resume state survives a batch and is dropped the moment the pass
           -- completes, so the next pass starts from the new watermark, clean.
           progress       = excluded.progress,
           updated_at     = excluded.updated_at`,
        [
          run.boardId,
          entry.source,
          outcome === "ok" ? cutoff : null,
          finishedAt,
          statusBySource.get(entry.source)!,
          detail,
          // Cards created stand whatever the outcome: a partial batch really did
          // import them, and crediting them only on `ok` would undercount.
          outcome === "throttled" || outcome === "failed" ? 0 : (perSource.get(entry.source) ?? 0),
          outcome === "throttled" ? cooldownUntil : null,
          nextProgress(entry, cutoff, outcome, input.sourceProgress?.[entry.source]),
          finishedAt,
        ],
      );
    }

    record(db, actor, "sync.completed", { boardId: run.boardId }, {
      runId,
      status: overall,
      sourceStatus: Object.fromEntries(outcomeBySource),
      imported: Object.fromEntries(perSource),
      detail,
      advanced: [...statusBySource.entries()].filter(([, value]) => value === "ok").map(([key]) => key),
      stillInPass: [...outcomeBySource.entries()]
        .filter(([, value]) => value !== "ok")
        .map(([key]) => key),
    });
  });

  log[overall === "ok" ? "info" : "warn"]("sync completed", {
    runId,
    boardId: run.boardId,
    status: overall,
    sourceStatus: Object.fromEntries(outcomeBySource),
    cooldownUntil: [...outcomeBySource.values()].includes("throttled") ? cooldownUntil : null,
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
