/**
 * Runs the inbox syncs the Sync button queues.
 *
 * The board app cannot read Outlook or Teams: the Express process holds no
 * Microsoft Graph credentials, and the access that does exist lives in the
 * Microsoft 365 MCP server, which is an agent's tool rather than a library. So
 * pressing Sync only records a request with a resolved time window; this process
 * is what turns that request into cards.
 *
 * Unlike the mention watcher this one picks up the existing queue at startup. A
 * queued sync is something the user explicitly asked for and is watching a
 * spinner for, so leaving it for later would be wrong.
 *
 * Microsoft 365 access comes from the user's own claude.ai connector, which is
 * already signed in — the same one an interactive session uses. Those credentials
 * live with the user's account and cannot be written into a config file, so this
 * is the one place a run is NOT given `--strict-mcp-config`: the generated config
 * is merged with the ambient one instead of replacing it. The board server is
 * still pinned there, so it keeps opening the database this watcher is reading.
 *
 * That makes the tool allowlist the real boundary, and it is drawn deliberately:
 * the connector also exposes `outlook_send_mail` and friends, so the run is given
 * an explicit list of **read** tools rather than the whole server. A sync reads
 * inboxes and writes cards; the ability to mail people as the user is pure
 * downside. It gets no file tools at all either, and never advances a watermark
 * itself — core does that, and only when the run reports it read the whole window.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cancelSyncRun,
  completeSyncRun,
  createLogger,
  getDb,
  getSyncRun,
  getSyncStates,
  listSyncRuns,
  looksThrottled,
  USER_CLAUDE,
  type ActorContext,
  type SyncRunWithContext,
  type SyncSource,
} from "../packages/core/src/index.ts";
import {
  argsFromEnv,
  boardServer,
  effectiveConfigDir,
  killActiveRuns,
  runClaude,
  writeMcpConfig,
} from "./lib/claude-run.ts";

const log = createLogger("sync-watch");

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

const INTERVAL_MS = Number(process.env.SYNC_WATCH_INTERVAL_MS ?? 10_000);
const TIMEOUT_MS = Number(process.env.SYNC_WATCH_TIMEOUT_MS ?? 900_000);
const CLAUDE_BIN = process.env.SYNC_WATCH_CLAUDE_BIN?.trim() || "claude";
const MODEL = process.env.SYNC_WATCH_MODEL?.trim() || "";
/** Prefix of the claude.ai Microsoft 365 connector's tools. */
const MS365_PREFIX = process.env.SYNC_WATCH_MS365_PREFIX?.trim() || "mcp__claude_ai_Microsoft_365";
/** How the connector names itself, for messages a human reads. */
const MS365_SERVER = MS365_PREFIX.replace(/^mcp__/, "").replace(/_/g, " ").trim() || "Microsoft 365";

/**
 * The read half of the Microsoft 365 connector. Listed one tool at a time on
 * purpose: allowing the server wholesale would also hand an unattended run
 * `outlook_send_mail` and `outlook_forward_mail`.
 *
 * `teams_list_chats` is deliberately NOT here, and it is the one omission that is
 * about cost rather than safety. A date-filtered `chat_message_search` already
 * spans every chat the user is in — the connector answers it by walking ~50 chats
 * itself — so enumerating chats first and searching them one by one reads the same
 * mail several times over and is the reliable way to earn a 429. The prompt says
 * so, but a prompt is advice and an allowlist is not, and this is exactly the kind
 * of thoroughness a model drifts into. Chat ids for `recipientRef` come out of the
 * search results. Restore it through `SYNC_WATCH_ALLOWED_TOOLS` if a run ever
 * genuinely needs the listing.
 */
const MS365_READ_TOOLS = [
  "get_me",
  "outlook_email_search",
  "chat_message_search",
  "outlook_calendar_search",
  "read_resource",
];

/** Board tools to write cards, connector read tools to see the inboxes. No file access. */
const ALLOWED_TOOLS =
  process.env.SYNC_WATCH_ALLOWED_TOOLS?.trim() ||
  ["mcp__board", ...MS365_READ_TOOLS.map((tool) => `${MS365_PREFIX}__${tool}`)].join(" ");
const EXTRA_ARGS = argsFromEnv(process.env.SYNC_WATCH_CLAUDE_ARGS);

/** The watcher's own writes are automation, not the model speaking. */
const watcher: ActorContext = { actorId: USER_CLAUDE, source: "system" };

const say = (message: string) => process.stderr.write(`${message}\n`);

/** Whose claude.ai account the pinned config dir signs runs in as, for the banner. */
function claudeAccount(): string {
  try {
    const config = JSON.parse(readFileSync(join(effectiveConfigDir(), ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    return config.oauthAccount?.emailAddress ?? "not signed in";
  } catch {
    return "unknown (no .claude.json there)";
  }
}

function buildPrompt(run: SyncRunWithContext): string {
  const scope = run.scope.map((entry) => `${entry.source} since ${entry.since}`).join(", ");
  return [
    "An inbox sync was queued on the shared kanban board. Run it.",
    "",
    `  run id  : ${run.id}`,
    `  board   : "${run.boardName}" (${run.boardId})`,
    `  window  : up to ${run.cutoff}, per source — ${scope}`,
    "",
    `Start with sync_claim ${run.id}. It returns the exact window to read, the board's states, and`,
    "the rules for what counts as a task — follow those rules rather than improvising, and read only",
    "inside the window it gives you.",
    "",
    "Then read the sources with the Microsoft 365 tools you have — outlook_email_search for mail, and",
    "for Teams ONE chat_message_search with afterDateTime/beforeDateTime set to the window, paged with",
    "offset. That one call already spans every chat: do not list chats and do not search chat by chat,",
    "because a date-filtered chat search is answered by walking ~50 chats internally, so extra passes",
    "are what trip the rate limit. Create a card per genuine outstanding item with task_create (always",
    "passing sourceRef so a repeat sync cannot duplicate it).",
    "",
    "Then, for each card you create, draft the reply the user owes with response_draft — two per",
    "person who needs an answer: stage=acknowledge to send now, stage=completion to send once the",
    "work is done. Do it in this run and not later: you have the message in front of you now, and",
    "after this run ends nobody does. sync_claim spells out the rules.",
    "",
    `Finish with sync_complete ${run.id}.`,
    "",
    "You have read tools only, and drafting is not sending: a draft sits on the board for the user to",
    "read, edit and send themselves. Nothing here can send mail or post to Teams, by design.",
    "",
    "Rules for finishing, which matter more than how much you import:",
    "  - Report status=ok only if you actually read the whole window. Reporting ok advances the",
    "    board's watermark, so a premature ok silently loses everything you did not read.",
    "  - If the Microsoft 365 tools error or report no access, complete the run with status=failed",
    "    and say exactly what they said. Do not try to authenticate — nobody is here to help.",
    "  - Microsoft Graph throttles (HTTP 429), Teams sooner than mail. You CANNOT wait it out: you have no",
    "    timer, no sleep and no shell. Saying you will retry shortly just ends this run with the request",
    "    still open, which the user sees as a failure having banked nothing. Call sync_complete straight",
    '    away with sourceStatus instead — the throttled source `throttled`, anything you finished `ok`.',
    "    The ok half keeps its progress, only the rest is re-read, and `throttled` additionally rests that",
    "    source so the next press does not walk into the same limit. A partial-results note from the Teams",
    "    search counts as throttled too: the window was not fully read.",
    "  - Complete the run even if you import nothing. An unfinished run leaves the board showing a",
    "    sync that never ends.",
    "  - You are unattended: there is no one to ask. When an item is genuinely ambiguous, skip it and",
    "    name it in the detail so the user can judge for themselves.",
  ].join("\n");
}

/**
 * Sources resting after a throttle, and until when.
 *
 * Core already records a cooldown per (board, source) and leaves a resting source
 * out of the next request, which handles the ordinary case. This map exists for
 * the case core cannot see: Graph's limits belong to the *mailbox*, so a board
 * that just got a 429 on Teams has spent the budget for every other board's Teams
 * too. Mirroring core's cooldown across boards is what stops a queue of several
 * boards taking turns hitting the same wall.
 *
 * Held per source rather than globally, because the old blanket hold also stopped
 * Outlook — which was never the source being throttled.
 */
const holdUntil = new Map<SyncSource, number>();

const heldSources = (): SyncSource[] =>
  [...holdUntil].filter(([, until]) => until > Date.now()).map(([source]) => source);

/**
 * Mirrors whatever cooldown core just recorded for this board into the map above.
 * Core is the source of truth — the run reported the throttle to it, not to us.
 */
function mirrorCooldowns(boardId: string): void {
  for (const state of getSyncStates(boardId)) {
    if (!state.cooldownUntil) continue;
    const until = new Date(state.cooldownUntil).getTime();
    if (until <= Date.now()) continue;
    if ((holdUntil.get(state.source) ?? 0) >= until) continue;
    holdUntil.set(state.source, until);
    log.warn("source throttled; holding it off across boards", { source: state.source, until: state.cooldownUntil });
    say(`  … ${state.source} throttled by Microsoft Graph — resting until ${state.cooldownUntil}`);
  }
}

/** Runs one queued sync and makes sure it cannot be left spinning. */
async function handle(run: SyncRunWithContext, mcpConfig: string): Promise<void> {
  log.info("dispatching sync", { runId: run.id, boardId: run.boardId, scope: run.scope, cutoff: run.cutoff });
  say(`→ ${run.id}  ${run.boardName}  [${run.scope.map((entry) => entry.source).join("+")}]`);

  const result = await runClaude({
    prompt: buildPrompt(run),
    mcpConfig,
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: TIMEOUT_MS,
    bin: CLAUDE_BIN,
    model: MODEL,
    extraArgs: EXTRA_ARGS,
    // The Microsoft 365 connector is account-level and cannot be declared in a
    // config file, so the ambient config has to stay visible. See the header.
    strictMcpConfig: false,
  });

  // The run was told to close itself out. Whether it did is the real outcome — a
  // zero exit code with the request still open is still a failure.
  const after = getSyncRun(run.id);
  if (after.status === "ok" || after.status === "failed") {
    // "failed" with cards imported is a partial, not a washout: per-source
    // completion means some watermarks moved. Say so, or the operator reads a
    // red line and assumes nothing happened.
    const partial = after.status === "failed" && after.imported > 0;
    log.info("sync handled", {
      runId: run.id,
      status: after.status,
      partial,
      imported: after.imported,
      seconds: result.seconds,
    });
    say(
      `  ${after.status === "ok" ? "✓" : partial ? "◐" : "✗"} ${
        partial ? `partial (${after.imported} imported)` : after.status
      } in ${result.seconds}s — ${after.detail ?? ""}`,
    );
    mirrorCooldowns(run.boardId);
    return;
  }

  // Left pending or running. Fail it rather than cancelling: failed keeps the
  // watermark unmoved *and* shows the reason on the board, so the next press of
  // Sync re-reads the same window.
  // The commonest cause by far is the Microsoft 365 server not being signed in,
  // which from here looks like a run that stalls and says nothing. Naming it beats
  // making the user read a timeout and guess.
  const hint = /timeout|killed|no output/i.test(result.summary)
    ? ` If this keeps happening, check that the ${MS365_SERVER} MCP server is signed in — an unauthenticated run stalls instead of failing fast.`
    : "";
  const detail =
    `The automated run did not finish (${result.seconds}s). Nothing was skipped — this window will be ` +
    `re-read next time.${hint} Last output: ${result.summary.slice(0, 600)}`;
  // A run that died never told core anything, so a 429 in its output would
  // otherwise be lost — and losing it means the next press walks straight back
  // into the limit. Attribute it to every source the run was carrying, since
  // there is nothing left to say which one it was.
  const sourceStatus = looksThrottled(result.summary)
    ? Object.fromEntries(run.scope.map((entry) => [entry.source, "throttled" as const]))
    : undefined;
  try {
    completeSyncRun(run.id, { status: "failed", sourceStatus, detail }, watcher);
  } catch {
    // Only reachable if it went terminal between the read above and here.
    cancelSyncRun(run.id, "automated run ended without completing", watcher);
  }
  log.warn("sync run ended without completing", { runId: run.id, seconds: result.seconds, summary: result.summary });
  say(`  ✗ did not finish; marked failed, watermark unchanged`);
  mirrorCooldowns(run.boardId);
}

// --- main loop ---------------------------------------------------------------

getDb(); // migrate before the first poll, and fail fast on a broken database

const mcpConfig = writeMcpConfig("sync-watch.mcp.json", { board: boardServer() });
const inFlight = new Set<string>();
let stopping = false;

say("");
say("  Inbox sync watcher");
say(`  claude binary : ${CLAUDE_BIN}${MODEL ? ` (model ${MODEL})` : ""}`);
say(`  allowed tools : ${ALLOWED_TOOLS}`);
say(`  mcp config    : ${mcpConfig} (board pinned; merged with your own config, not strict)`);
say(`  microsoft 365 : your claude.ai connector, read tools only`);
// The connector belongs to an account, and the account is decided by this directory.
// Print it: "no Microsoft 365 tools" and "signed in as the wrong account" look identical
// from inside a run, and this is the line that tells them apart.
say(`  claude account: ${claudeAccount()} (config dir ${effectiveConfigDir()})`);
say(`  poll / timeout: ${INTERVAL_MS}ms / ${Math.round(TIMEOUT_MS / 1000)}s per run`);
say(`  throttle hold : per source, mirrored from the cooldown core records on a 429`);
say(`  teams         : one date-filtered chat search per run, never a per-chat walk`);
say(`  mode          : ${DRY_RUN ? "DRY RUN — nothing is spawned" : ONCE ? "one pass" : "watching"}`);
say("");
say("  Runs here read your mail and Teams messages. They cannot send mail, post to Teams,");
say("  or touch the filesystem.");
say("");

async function pass(): Promise<void> {
  const pending = listSyncRuns({ status: "pending", oldestFirst: true, limit: 20 });
  for (const run of pending) {
    if (stopping) return;
    if (inFlight.has(run.id)) continue;

    // A run queued before the throttle can still name a resting source. Hold it
    // only when there is nothing else in its scope worth reading — a mixed run
    // is dispatched, because the Outlook half is real work and the Teams half
    // just re-reports the limit.
    const held = heldSources();
    if (held.length > 0 && run.scope.every((entry) => held.includes(entry.source))) {
      log.debug("holding run; every source in scope is resting", { runId: run.id, held });
      continue;
    }

    if (DRY_RUN) {
      say(`\n--- would spawn for ${run.id} ---\n${buildPrompt(run)}\n`);
      continue;
    }

    // Serial on purpose: two runs importing into the same board at once is a
    // worse failure than a sync waiting a few seconds.
    inFlight.add(run.id);
    try {
      // Claiming is left to the spawned run, so the audit trail names the actor
      // that did the work and a second watcher loses the claim rather than the work.
      await handle(run, mcpConfig);
    } catch (error) {
      log.error("dispatch failed", { runId: run.id, error });
      say(`  ! ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(run.id);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info("sync watcher stopping", { signal });
    // Each run lives in its own process group, so it does not get the terminal's
    // Ctrl-C for free — take it down explicitly rather than orphaning it.
    killActiveRuns();
    say("\nstopped.");
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

log.info("sync watcher started", { intervalMs: INTERVAL_MS, allowedTools: ALLOWED_TOOLS, dryRun: DRY_RUN });

await pass();
if (!ONCE && !DRY_RUN) {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await pass();
  }
}
