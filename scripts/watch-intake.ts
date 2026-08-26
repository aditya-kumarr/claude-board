/**
 * Turns what the user pasted into a board's chat into cards on that board.
 *
 * The board has an intake box: drop in a CSV export, the notes from a call, a
 * forwarded thread, a screenshot of somebody's whiteboard, and say what you want
 * made of it. The Express process cannot read any of that into tasks — it has no
 * model access — so pasting records the material and this process is what turns it
 * into cards.
 *
 * The interesting thing here is that **the tool allowlist is computed per message,
 * not per watcher.** Text-bearing attachments are decoded at upload and travel
 * inline in the prompt, so a pasted CSV — the common case — gives the run the board
 * server and nothing else: no file tools at all. Only a screenshot or a PDF leaves
 * something on disk that has to be opened, and only then is `Read` added, for that
 * one run. Least privilege per paste rather than a single allowlist wide enough for
 * the worst case.
 *
 * `Read` is the widest thing this watcher ever grants, and it is worth being clear
 * about what that means: it reads files, anywhere the process can, and the run is
 * spawned from the repo root. It gets no Write, no Edit, no Bash, no other MCP
 * server. Set INTAKE_WATCH_ALLOW_FILE_READS=false to refuse it outright, in which
 * case a run that is given a screenshot reports that it could not open it rather
 * than inventing what it said.
 */
// Relative, not "@automation/core": scripts/ sits outside the bun workspace, so
// the package alias is not resolvable here — same as the other watchers.
import {
  cancelIntakeMessage,
  completeIntakeMessage,
  createLogger,
  getDb,
  getIntakeMessage,
  listIntakeMessages,
  releaseIntakeMessage,
  USER_CLAUDE,
  type ActorContext,
  type IntakeMessageWithContext,
} from "../packages/core/src/index.ts";
import { argsFromEnv, boardServer, killActiveRuns, runClaude, writeMcpConfig } from "./lib/claude-run.ts";

const log = createLogger("intake-watch");

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

const INTERVAL_MS = Number(process.env.INTAKE_WATCH_INTERVAL_MS ?? 5_000);
const TIMEOUT_MS = Number(process.env.INTAKE_WATCH_TIMEOUT_MS ?? 600_000);
const CLAUDE_BIN = process.env.INTAKE_WATCH_CLAUDE_BIN?.trim() || "claude";
const MODEL = process.env.INTAKE_WATCH_MODEL?.trim() || "";
const EXTRA_ARGS = argsFromEnv(process.env.INTAKE_WATCH_CLAUDE_ARGS);
/** Spawns per message before giving up and saying so in the chat. */
const MAX_ATTEMPTS = Math.max(Number(process.env.INTAKE_WATCH_MAX_ATTEMPTS ?? 2), 1);

/** Board tools only. Everything a text paste needs. */
const BASE_TOOLS = process.env.INTAKE_WATCH_ALLOWED_TOOLS?.trim() || "mcp__board";
/**
 * Added for a run that was given a screenshot or a PDF, and only for that run. Set
 * false to withhold it entirely: the run then reports that it could not open the
 * file, which is a better outcome than a card invented from an unread image.
 */
const ALLOW_FILE_READS = process.env.INTAKE_WATCH_ALLOW_FILE_READS !== "false";

/** The watcher's own writes are automation, not the model speaking. */
const watcher: ActorContext = { actorId: USER_CLAUDE, source: "system" };

const say = (message: string) => process.stderr.write(`${message}\n`);

/** What this particular message needs, and nothing more. */
function toolsFor(message: IntakeMessageWithContext): string {
  if (message.readablePaths.length === 0 || !ALLOW_FILE_READS) return BASE_TOOLS;
  return `${BASE_TOOLS} Read`;
}

function buildPrompt(message: IntakeMessageWithContext): string {
  const files = message.readablePaths;
  return [
    "Somebody pasted raw material into a board's intake chat and wants cards made from it. Do it.",
    "",
    `  message id : ${message.id}`,
    `  board      : "${message.boardName}" (${message.boardId}), closes ${message.boardEndsAt}`,
    `  they typed : ${message.instruction || "(nothing — they pasted it and left the reading to you)"}`,
    message.content ? `  pasted     : ${message.content.split("\n").length} line(s) of text` : null,
    message.attachments.length > 0
      ? `  files      : ${message.attachments.map((file) => `${file.filename} [${file.kind}]`).join(", ")}`
      : null,
    "",
    `Start with intake_claim ${message.id}. It returns the material in full — the pasted text, the`,
    "contents of any text file, the on-disk path of anything you need to open — plus this board's",
    "states, its deadline, and the cards already on it. It also carries the rules for what should",
    "become a card and what should not: follow those rather than improvising.",
    "",
    files.length > 0
      ? ALLOW_FILE_READS
        ? `You have Read for the ${files.length} file(s) it names. Open each one — a screenshot is often\n` +
          "where the real detail is, so read it before deciding what the cards are."
        : `This message has ${files.length} file(s) you CANNOT open: file reading is switched off for this\n` +
          "watcher. Work from the typed instruction and any pasted text, and say plainly in your reply\n" +
          "that you could not read the attachments — do not guess at what they contained."
      : "Everything you need arrives inline. You have no file tools, and do not need any.",
    "",
    "Then create the cards with task_create, and finish with intake_complete: the ids you created,",
    "and a reply written to the person who pasted it.",
    "",
    "Rules for finishing, which matter more than how many cards you make:",
    "  - Say what you SKIPPED and why. A row that was already done, a line that was a total, a box",
    "    on the whiteboard that was not work — naming those is how they know you read it properly.",
    "  - Do not invent work that was not in the material, and do not pad a short list.",
    "  - Check against the cards already on the board. Duplicating work that is already there is",
    "    worse than skipping it, because they now have to spot it.",
    "  - A due date must fall inside the board's window. If the data gives one outside it, leave it",
    "    off and say so — silently moving their deadline is not yours to do.",
    "  - You are unattended: there is nobody to ask. Make the cards you are sure of, and name what",
    "    was ambiguous in your reply so they can judge it themselves.",
    "  - Complete the message even if you create nothing. One left claimed shows them a paste that",
    "    is still being read, forever.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Runs one message and makes sure it cannot be left spinning in the chat. */
async function handle(message: IntakeMessageWithContext, mcpConfig: string, attempt: number): Promise<void> {
  const allowedTools = toolsFor(message);
  log.info("dispatching intake message", {
    messageId: message.id,
    boardId: message.boardId,
    attachments: message.attachments.length,
    readable: message.readablePaths.length,
    allowedTools,
    attempt,
  });
  say(
    `→ ${message.id}  ${message.boardName}  ` +
      `[${allowedTools}]${attempt > 1 ? `  (attempt ${attempt})` : ""}`,
  );

  const result = await runClaude({
    prompt: buildPrompt(message),
    mcpConfig,
    allowedTools,
    timeoutMs: TIMEOUT_MS,
    bin: CLAUDE_BIN,
    model: MODEL,
    extraArgs: EXTRA_ARGS,
  });

  // The run was told to close itself out. Whether it did is the real outcome — a
  // zero exit code with the message still open is still a failure.
  const after = getIntakeMessage(message.id);
  if (after.status === "done" || after.status === "failed" || after.status === "cancelled") {
    log.info("intake message handled", {
      messageId: message.id,
      status: after.status,
      created: after.createdTasks.length,
      seconds: result.seconds,
    });
    say(
      `  ${after.status === "done" ? "✓" : "✗"} ${after.status} in ${result.seconds}s, ` +
        `${after.createdTasks.length} card(s) — ${after.note ?? ""}`,
    );
    return;
  }

  // Still open. A retry is cheap; a lost paste means the user re-does the work of
  // finding and copying the material.
  if (attempt < MAX_ATTEMPTS) {
    releaseIntakeMessage(message.id, `run ${attempt} ended without completing (${result.seconds}s)`, watcher);
    log.warn("intake message released for retry", { messageId: message.id, attempt, summary: result.summary });
    say(`  … did not finish; releasing for attempt ${attempt + 1}`);
    return;
  }

  // Out of attempts. Fail it with the run's last output rather than leaving it
  // claimed: either way no cards were made, but only one of the two says why.
  const note =
    `The automated run did not finish after ${MAX_ATTEMPTS} attempt(s), so nothing was created and the ` +
    `material is still here. Last output: ${result.summary.slice(0, 800)}`;
  try {
    completeIntakeMessage(message.id, { status: "failed", note }, watcher);
  } catch {
    // Only reachable if it went terminal between the read above and here.
    cancelIntakeMessage(message.id, "automated run ended without completing", watcher);
  }
  log.warn("intake message gave up", { messageId: message.id, attempts: attempt, summary: result.summary });
  say(`  ✗ gave up after ${attempt} attempt(s); the reason is in the chat`);
}

// --- main loop ---------------------------------------------------------------

getDb(); // migrate before the first poll, and fail fast on a broken database

const mcpConfig = writeMcpConfig("intake-watch.mcp.json", { board: boardServer() });
const inFlight = new Set<string>();
const attempts = new Map<string, number>();
let stopping = false;

say("");
say("  Board intake watcher");
say(`  claude binary : ${CLAUDE_BIN}${MODEL ? ` (model ${MODEL})` : ""}`);
say(`  base tools    : ${BASE_TOOLS}`);
say(`  file reads    : ${ALLOW_FILE_READS ? "Read added only for a message with a screenshot or PDF" : "OFF — attachments will be reported unread"}`);
say(`  mcp config    : ${mcpConfig} (board server only, strict)`);
say(`  poll / timeout: ${INTERVAL_MS}ms / ${Math.round(TIMEOUT_MS / 1000)}s per run`);
say(`  attempts      : ${MAX_ATTEMPTS} per message before it fails with a reason`);
say(`  mode          : ${DRY_RUN ? "DRY RUN — nothing is spawned" : ONCE ? "one pass" : "watching"}`);
say("");
say("  Runs here read what was pasted and create cards. They cannot send mail, post to Teams,");
say("  reach any other MCP server, or write to the filesystem.");
say("");

async function pass(): Promise<void> {
  const pending = listIntakeMessages({ status: "pending", oldestFirst: true, limit: 20 });
  for (const summary of pending) {
    if (stopping) return;
    if (inFlight.has(summary.id)) continue;

    // The listing is deliberately light; the full context (resolved file paths,
    // board window) is what decides the allowlist, so read it before dispatching.
    const message = getIntakeMessage(summary.id);

    if (DRY_RUN) {
      say(`\n--- would spawn for ${message.id} with [${toolsFor(message)}] ---\n${buildPrompt(message)}\n`);
      continue;
    }

    const attempt = (attempts.get(message.id) ?? 0) + 1;
    attempts.set(message.id, attempt);

    // Serial on purpose: two runs importing onto the same board at once is a worse
    // failure than a paste waiting a few seconds.
    inFlight.add(message.id);
    try {
      // Claiming is left to the spawned run, so the audit trail names the actor
      // that did the work and a second watcher loses the claim rather than the work.
      await handle(message, mcpConfig, attempt);
    } catch (error) {
      log.error("dispatch failed", { messageId: message.id, error });
      say(`  ! ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(message.id);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info("intake watcher stopping", { signal });
    // Each run lives in its own process group, so it does not get the terminal's
    // Ctrl-C for free — take it down explicitly rather than orphaning it.
    killActiveRuns();
    say("\nstopped.");
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

log.info("intake watcher started", { intervalMs: INTERVAL_MS, baseTools: BASE_TOOLS, dryRun: DRY_RUN });

await pass();
if (!ONCE && !DRY_RUN) {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await pass();
  }
}
