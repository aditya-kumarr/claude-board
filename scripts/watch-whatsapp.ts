/**
 * Turns uploaded WhatsApp chat exports into cards on the board they were uploaded to.
 *
 * The board app parses the zip at upload — the transcript into messages, each
 * message joined to the file it carried, the window cut at this board's watermark
 * for that chat — but it cannot decide which messages are work. This process
 * spawns a `claude -p` run per import to do that.
 *
 * As with the intake watcher, **the allowlist is computed per import**. The
 * messages travel inline in the claim, so the ordinary upload gives the run the
 * board server and nothing else. `Read` is added only when the upload asked for its
 * photos to be read and there is a photo that can be opened — photos are the only
 * media ever read, and only on request. WHATSAPP_WATCH_ALLOW_PHOTO_READS=false
 * refuses it outright; a run then says which cards rest on photos it did not see.
 *
 * `Read` reads files anywhere the process can, from the repo root. It gets no
 * Write, no Edit, no Bash and no other MCP server.
 */
// Relative, not "@automation/core": scripts/ sits outside the bun workspace, so
// the package alias is not resolvable here — same as the other watchers.
import {
  cancelWhatsAppImport,
  completeWhatsAppImport,
  createLogger,
  getDb,
  getWhatsAppImport,
  listWhatsAppImports,
  releaseWhatsAppImport,
  USER_CLAUDE,
  type ActorContext,
  type WhatsAppImportWithContext,
} from "../packages/core/src/index.ts";
import { argsFromEnv, boardServer, killActiveRuns, runClaude, writeMcpConfig } from "./lib/claude-run.ts";

const log = createLogger("whatsapp-watch");

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");

const INTERVAL_MS = Number(process.env.WHATSAPP_WATCH_INTERVAL_MS ?? 5_000);
const TIMEOUT_MS = Number(process.env.WHATSAPP_WATCH_TIMEOUT_MS ?? 900_000);
const CLAUDE_BIN = process.env.WHATSAPP_WATCH_CLAUDE_BIN?.trim() || "claude";
const MODEL = process.env.WHATSAPP_WATCH_MODEL?.trim() || "";
const EXTRA_ARGS = argsFromEnv(process.env.WHATSAPP_WATCH_CLAUDE_ARGS);
const MAX_ATTEMPTS = Math.max(Number(process.env.WHATSAPP_WATCH_MAX_ATTEMPTS ?? 2), 1);

const BASE_TOOLS = process.env.WHATSAPP_WATCH_ALLOWED_TOOLS?.trim() || "mcp__board";
const ALLOW_PHOTO_READS = process.env.WHATSAPP_WATCH_ALLOW_PHOTO_READS !== "false";

/** The watcher's own writes are automation, not the model speaking. */
const watcher: ActorContext = { actorId: USER_CLAUDE, source: "system" };

const say = (message: string) => process.stderr.write(`${message}\n`);

/** What this import needs, and nothing more. */
function toolsFor(entry: WhatsAppImportWithContext): string {
  if (entry.readablePaths.length === 0 || !ALLOW_PHOTO_READS) return BASE_TOOLS;
  return `${BASE_TOOLS} Read`;
}

function buildPrompt(entry: WhatsAppImportWithContext): string {
  const photos = entry.readablePaths.length;
  return [
    "Somebody uploaded a WhatsApp chat export to a board and wants cards for the work in it. Do it.",
    "",
    `  import id  : ${entry.id}`,
    `  chat       : "${entry.chatName}" — ${entry.messageCount} new message(s), ${entry.mediaCount} file(s)`,
    `  board      : "${entry.boardName}" (${entry.boardId}), closes ${entry.boardEndsAt}`,
    `  they typed : ${entry.instruction || "(nothing — find the work the chat asks of them)"}`,
    "",
    `Start with whatsapp_claim ${entry.id}. It returns every message in the window, oldest first, with who`,
    "sent it, when, what file it carried, and the ref to use in each card's sourceRef — plus the board's",
    "states, its deadline and the cards already on it, and the rules for what counts as a card.",
    "",
    photos > 0
      ? ALLOW_PHOTO_READS
        ? `They asked for the photos to be read, so you have Read for the ${photos} photo path(s) it lists.\n` +
          "Open the ones a card might depend on. Do not try to open anything else."
        : `They asked for the photos to be read, but photo reading is switched off for this watcher. Work\n` +
          "from the text, and say which cards depend on a photo you could not see."
      : "Everything you need arrives inline. You have no file tools and are not meant to open any media.",
    "",
    "Then create the cards with task_create (always with the sourceRef it describes). When a card owns a",
    "photo other than the one on its own source message — a follow-up \"same here\" screenshot — put it on",
    "the card with whatsapp_link_photos. Finish with whatsapp_complete: the ids you created and a reply to",
    "the person who uploaded it.",
    "",
    "Rules for finishing:",
    "  - Say what you SKIPPED and why, briefly. That is how they know you read the chat.",
    "  - Do not invent work, and do not make a card per message — one piece of work is one card.",
    "  - Check against the cards already on the board, and skip what is there.",
    "  - A due date must fall inside the board's window; leave it off and say so if it does not.",
    "  - Complete it even if nothing was work. Completing it done is what marks these messages as read,",
    "    so the next upload of this chat starts after them.",
  ].join("\n");
}

async function handle(entry: WhatsAppImportWithContext, mcpConfig: string, attempt: number): Promise<void> {
  const allowedTools = toolsFor(entry);
  log.info("dispatching whatsapp import", {
    importId: entry.id,
    boardId: entry.boardId,
    chat: entry.chatKey,
    messages: entry.messageCount,
    photos: entry.readablePaths.length,
    allowedTools,
    attempt,
  });
  say(`→ ${entry.id}  ${entry.boardName} / ${entry.chatName}  [${allowedTools}]${attempt > 1 ? `  (attempt ${attempt})` : ""}`);

  const result = await runClaude({
    prompt: buildPrompt(entry),
    mcpConfig,
    allowedTools,
    timeoutMs: TIMEOUT_MS,
    bin: CLAUDE_BIN,
    model: MODEL,
    extraArgs: EXTRA_ARGS,
  });

  // Whether the run closed the import out is the real outcome — exit 0 with the
  // import still open is a failure.
  const after = getWhatsAppImport(entry.id);
  if (after.status === "done" || after.status === "failed" || after.status === "cancelled") {
    log.info("whatsapp import handled", { importId: entry.id, status: after.status, created: after.createdTasks.length, seconds: result.seconds });
    say(`  ${after.status === "done" ? "✓" : "✗"} ${after.status} in ${result.seconds}s, ${after.createdTasks.length} card(s) — ${after.note ?? ""}`);
    return;
  }

  if (attempt < MAX_ATTEMPTS) {
    releaseWhatsAppImport(entry.id, `run ${attempt} ended without completing (${result.seconds}s)`, watcher);
    log.warn("whatsapp import released for retry", { importId: entry.id, attempt, summary: result.summary });
    say(`  … did not finish; releasing for attempt ${attempt + 1}`);
    return;
  }

  // Failed rather than left claimed: the watermark stays put either way, but only
  // this says why, and it frees the chat for its next upload.
  const note =
    `The automated run did not finish after ${MAX_ATTEMPTS} attempt(s), so nothing was created and these messages ` +
    `will be offered again on the next upload. Last output: ${result.summary.slice(0, 800)}`;
  try {
    completeWhatsAppImport(entry.id, { status: "failed", note }, watcher);
  } catch {
    cancelWhatsAppImport(entry.id, "automated run ended without completing", watcher);
  }
  log.warn("whatsapp import gave up", { importId: entry.id, attempts: attempt, summary: result.summary });
  say(`  ✗ gave up after ${attempt} attempt(s); the reason is on the board`);
}

// --- main loop ---------------------------------------------------------------

getDb(); // migrate before the first poll, and fail fast on a broken database

const mcpConfig = writeMcpConfig("whatsapp-watch.mcp.json", { board: boardServer() });
const inFlight = new Set<string>();
const attempts = new Map<string, number>();
let stopping = false;

say("");
say("  WhatsApp import watcher");
say(`  claude binary : ${CLAUDE_BIN}${MODEL ? ` (model ${MODEL})` : ""}`);
say(`  base tools    : ${BASE_TOOLS}`);
say(`  photo reads   : ${ALLOW_PHOTO_READS ? "Read added only for an upload that asked for its photos to be read" : "OFF — photos are never opened"}`);
say(`  mcp config    : ${mcpConfig} (board server only, strict)`);
say(`  poll / timeout: ${INTERVAL_MS}ms / ${Math.round(TIMEOUT_MS / 1000)}s per run`);
say(`  attempts      : ${MAX_ATTEMPTS} per import before it fails with a reason`);
say(`  mode          : ${DRY_RUN ? "DRY RUN — nothing is spawned" : ONCE ? "one pass" : "watching"}`);
say("");
say("  Runs here read the uploaded messages and create cards. They cannot send WhatsApp messages,");
say("  reach any other MCP server, or write to the filesystem.");
say("");

async function pass(): Promise<void> {
  const pending = listWhatsAppImports({ status: "pending", oldestFirst: true, limit: 20 });
  for (const summary of pending) {
    if (stopping) return;
    if (inFlight.has(summary.id)) continue;
    // The full context carries the resolved photo paths, which decide the allowlist.
    const entry = getWhatsAppImport(summary.id);

    if (DRY_RUN) {
      say(`\n--- would spawn for ${entry.id} with [${toolsFor(entry)}] ---\n${buildPrompt(entry)}\n`);
      continue;
    }

    const attempt = (attempts.get(entry.id) ?? 0) + 1;
    attempts.set(entry.id, attempt);

    // Serial on purpose: two runs importing onto one board at once is worse than a wait.
    inFlight.add(entry.id);
    try {
      // Claiming is left to the spawned run, so the audit trail names the actor that did the work.
      await handle(entry, mcpConfig, attempt);
    } catch (error) {
      log.error("dispatch failed", { importId: entry.id, error });
      say(`  ! ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(entry.id);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info("whatsapp watcher stopping", { signal });
    // Each run lives in its own process group; take it down rather than orphaning it.
    killActiveRuns();
    say("\nstopped.");
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

log.info("whatsapp watcher started", { intervalMs: INTERVAL_MS, baseTools: BASE_TOOLS, dryRun: DRY_RUN });

await pass();
if (!ONCE && !DRY_RUN) {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await pass();
  }
}
