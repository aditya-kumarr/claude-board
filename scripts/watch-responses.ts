/**
 * Carries out the changes the user asks for on their draft replies.
 *
 * The board holds a draft reply per person per card, and under each one a box the
 * user types into: "make this shorter", "push back on the date", "drop the last
 * paragraph". The Express process cannot act on that — it has no model access — so
 * the ask is queued as a turn and this process is what turns it into new words.
 *
 * The security story here is the simplest of the three watchers, and deliberately
 * so. Rewriting a message the user is about to send needs the board and nothing
 * else: no Microsoft 365 connector, no filesystem, no other MCP server. So the run
 * gets a generated config holding only the board server, `--strict-mcp-config` to
 * make that genuinely all it can see, and `mcp__board` as its entire allowlist.
 *
 * Worth saying plainly, because it is the whole shape of the feature: **nothing
 * here sends anything.** There is no send tool in the allowlist, no Graph write
 * scope anywhere in the repo, and no code path that posts a message. A reply is
 * marked sent when the user tells the board they sent it. The value is having the
 * right words ready at the moment they are needed; an unattended process able to
 * mail the user's colleagues would be pure downside.
 *
 * Like the sync watcher, this one works the queue that already exists at startup.
 * A queued change is something the user typed and is watching a spinner for, so
 * deferring it would be wrong — whereas the mention watcher's backlog is somebody
 * else's business unless asked for.
 */
// Relative, not "@automation/core": scripts/ sits outside the bun workspace, so
// the package alias is not resolvable here — same as the other watchers.
import {
  cancelResponseTurn,
  completeResponseTurn,
  createLogger,
  getDb,
  getResponseTurn,
  listResponseTurns,
  releaseResponseTurn,
  USER_CLAUDE,
  type ActorContext,
  type ResponseTurnWithContext,
} from "../packages/core/src/index.ts";
import { argsFromEnv, boardServer, killActiveRuns, runClaude, writeMcpConfig } from "./lib/claude-run.ts";

const log = createLogger("response-watch");

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

const INTERVAL_MS = Number(process.env.RESPONSE_WATCH_INTERVAL_MS ?? 5_000);
const TIMEOUT_MS = Number(process.env.RESPONSE_WATCH_TIMEOUT_MS ?? 300_000);
const CLAUDE_BIN = process.env.RESPONSE_WATCH_CLAUDE_BIN?.trim() || "claude";
const MODEL = process.env.RESPONSE_WATCH_MODEL?.trim() || "";
/**
 * The board and nothing else. Rewriting a paragraph does not need file access, and
 * an unattended run triggered by a web form should not have it.
 */
const ALLOWED_TOOLS = process.env.RESPONSE_WATCH_ALLOWED_TOOLS?.trim() || "mcp__board";
const EXTRA_ARGS = argsFromEnv(process.env.RESPONSE_WATCH_CLAUDE_ARGS);
/** Spawns per turn before giving up and putting the reason in the panel. */
const MAX_ATTEMPTS = Math.max(Number(process.env.RESPONSE_WATCH_MAX_ATTEMPTS ?? 2), 1);

/** The watcher's own writes are automation, not the model speaking. */
const watcher: ActorContext = { actorId: USER_CLAUDE, source: "system" };

const say = (message: string) => process.stderr.write(`${message}\n`);

function buildPrompt(turn: ResponseTurnWithContext): string {
  const shared = [
    "",
    `Start with response_claim ${turn.id}. It returns the instruction, the card it belongs to and`,
    "— for a change to an existing reply — that reply in full, plus the rules for carrying it out.",
    "Follow those rather than improvising.",
    "",
    "You are drafting a message the user will read, possibly edit, and send themselves. You cannot",
    "send anything and you cannot see their mailbox: work from the card. Do not invent a fact, a date",
    "or a name that is not on it — if the card does not say when something will be done, write a reply",
    "that does not promise a date.",
    "",
    `Finish with response_complete ${turn.id}: the new body, plus a one-line note written to the user`,
    "saying what you changed. If you cannot do what was asked, complete it with status=failed and the",
    "reason in the note. Do not finish while the turn is still open — the panel would show a change",
    "that never arrives, which is worse for them than one that failed with an explanation.",
  ];

  if (turn.kind === "revise") {
    return [
      "The user asked for a change to a reply they are about to send. Make it.",
      "",
      `  turn id     : ${turn.id}`,
      `  what to do  : ${turn.instruction}`,
      `  the reply    : ${turn.responseId} — ${turn.response?.channel === "chat" ? "a Teams message" : "an email"}` +
        ` to ${turn.response?.recipientName ?? "someone"}, stage ${turn.response?.stage ?? "?"}`,
      `  on card     : ${turn.taskId} — "${turn.taskTitle}"`,
      `  board       : "${turn.boardName}" (${turn.boardId})`,
      "",
      "Rewrite the WHOLE message, applying the instruction and changing nothing else. The user is",
      "iterating on words they are about to send: an unasked-for change to a sentence they were happy",
      "with is a change they have to notice and undo. Keep their voice, keep it first person.",
      ...shared,
    ].join("\n");
  }

  return [
    "A card on the board has no reply drafted for it, and the user asked for one. Write it.",
    "",
    `  turn id     : ${turn.id}`,
    `  what to do  : ${turn.instruction}`,
    `  on card     : ${turn.taskId} — "${turn.taskTitle}"`,
    `  state       : ${turn.columnName} (${turn.columnKind})`,
    `  board       : "${turn.boardName}" (${turn.boardId}), closes ${turn.boardEndsAt}`,
    turn.taskSourceRef ? `  imported from: ${turn.taskSourceRef}` : "  (typed in by hand, not imported)",
    "",
    "Read the card with task_get first — its description is the only record of who asked and what for.",
    "Then write, per person who needs an answer, two drafts with response_draft: stage=acknowledge for",
    "the reply to send now, stage=completion for the one to send once the work is done. If more than",
    "one person needs a separate answer, draft one each rather than merging them.",
    ...shared,
  ].join("\n");
}

/** Runs one turn and makes sure it cannot be left spinning in the panel. */
async function handle(turn: ResponseTurnWithContext, mcpConfig: string, attempt: number): Promise<void> {
  log.info("dispatching reply turn", {
    turnId: turn.id,
    kind: turn.kind,
    responseId: turn.responseId,
    taskId: turn.taskId,
    attempt,
  });
  say(`→ ${turn.id}  ${turn.kind}  "${turn.instruction.slice(0, 60)}"${attempt > 1 ? `  (attempt ${attempt})` : ""}`);

  const result = await runClaude({
    prompt: buildPrompt(turn),
    mcpConfig,
    allowedTools: ALLOWED_TOOLS,
    timeoutMs: TIMEOUT_MS,
    bin: CLAUDE_BIN,
    model: MODEL,
    extraArgs: EXTRA_ARGS,
  });

  // The run was told to close itself out. Whether it did is the real outcome — a
  // zero exit code with the turn still open is still a failure.
  const after = getResponseTurn(turn.id);
  if (after.status === "done" || after.status === "failed" || after.status === "cancelled") {
    log.info("reply turn handled", { turnId: turn.id, status: after.status, seconds: result.seconds });
    say(`  ${after.status === "done" ? "✓" : "✗"} ${after.status} in ${result.seconds}s — ${after.note ?? ""}`);
    return;
  }

  // Still open. A retry is cheap and a dropped instruction is not, so hand it back
  // until the attempts run out.
  if (attempt < MAX_ATTEMPTS) {
    releaseResponseTurn(turn.id, `run ${attempt} ended without completing (${result.seconds}s)`, watcher);
    log.warn("reply turn released for retry", { turnId: turn.id, attempt, summary: result.summary });
    say(`  … did not finish; releasing for attempt ${attempt + 1}`);
    return;
  }

  // Out of attempts. Fail it with the run's last output rather than leaving it
  // claimed: the draft keeps its current text either way, but only one of those
  // two outcomes tells the user why nothing changed.
  const note =
    `The automated run did not finish after ${MAX_ATTEMPTS} attempt(s), so the draft is unchanged. ` +
    `Last output: ${result.summary.slice(0, 600)}`;
  try {
    completeResponseTurn(turn.id, { status: "failed", note }, watcher);
  } catch {
    // Only reachable if it went terminal between the read above and here.
    cancelResponseTurn(turn.id, "automated run ended without completing", watcher);
  }
  log.warn("reply turn gave up", { turnId: turn.id, attempts: attempt, summary: result.summary });
  say(`  ✗ gave up after ${attempt} attempt(s); the reason is on the draft`);
}

// --- main loop ---------------------------------------------------------------

getDb(); // migrate before the first poll, and fail fast on a broken database

const mcpConfig = writeMcpConfig("response-watch.mcp.json", { board: boardServer() });
const inFlight = new Set<string>();
const attempts = new Map<string, number>();
let stopping = false;

say("");
say("  Draft-reply watcher");
say(`  claude binary : ${CLAUDE_BIN}${MODEL ? ` (model ${MODEL})` : ""}`);
say(`  allowed tools : ${ALLOWED_TOOLS}`);
say(`  mcp config    : ${mcpConfig} (board server only, strict)`);
say(`  poll / timeout: ${INTERVAL_MS}ms / ${Math.round(TIMEOUT_MS / 1000)}s per run`);
say(`  attempts      : ${MAX_ATTEMPTS} per change before it fails with a reason`);
say(`  mode          : ${DRY_RUN ? "DRY RUN — nothing is spawned" : ONCE ? "one pass" : "watching"}`);
say("");
say("  Runs here rewrite draft replies on the board. They cannot send mail, post to Teams,");
say("  reach any other MCP server, or touch the filesystem.");
say("");

async function pass(): Promise<void> {
  const pending = listResponseTurns({ status: "pending", oldestFirst: true, limit: 20 });
  for (const turn of pending) {
    if (stopping) return;
    if (inFlight.has(turn.id)) continue;

    if (DRY_RUN) {
      say(`\n--- would spawn for ${turn.id} ---\n${buildPrompt(turn)}\n`);
      continue;
    }

    const attempt = (attempts.get(turn.id) ?? 0) + 1;
    attempts.set(turn.id, attempt);

    // Serial on purpose: two runs rewriting drafts on one card at once is a worse
    // failure than a change waiting a few seconds.
    inFlight.add(turn.id);
    try {
      // Claiming is left to the spawned run, so the audit trail names the actor
      // that did the work and a second watcher loses the claim rather than the work.
      await handle(turn, mcpConfig, attempt);
    } catch (error) {
      log.error("dispatch failed", { turnId: turn.id, error });
      say(`  ! ${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(turn.id);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info("response watcher stopping", { signal });
    // Each run lives in its own process group, so it does not get the terminal's
    // Ctrl-C for free — take it down explicitly rather than orphaning it.
    killActiveRuns();
    say("\nstopped.");
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

log.info("response watcher started", { intervalMs: INTERVAL_MS, allowedTools: ALLOWED_TOOLS, dryRun: DRY_RUN });

await pass();
if (!ONCE && !DRY_RUN) {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await pass();
  }
}
