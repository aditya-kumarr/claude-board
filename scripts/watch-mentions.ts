/**
 * Turns an `@claude` left on the board into Claude actually doing the thing.
 *
 * Core already records every mention as a tracked request, and the MCP tools let
 * Claude work through them in a session. This closes the last gap: a note left
 * from a tablet at midnight gets picked up without anyone opening a terminal.
 *
 * Where the run happens is decided by the card. A card (or its whole board) can
 * name a *project* — a directory on this machine — and when one resolves, the run
 * is spawned with that directory as its working directory. That is the whole
 * point of the feature: "fix the duplicate button on the facility details page"
 * is not answerable from this repository, and it is answerable from the checkout
 * the page lives in, where the run picks up that project's own CLAUDE.md and
 * files and nothing else.
 *
 * Be clear about what this process is. It spawns a real Claude Code run, with
 * tool access, on input typed into a form that — behind `bun run tunnel` — is
 * reachable from the internet. The Cloudflare Access policy in front of the board
 * is what decides who can queue work here; this script is downstream of that
 * decision and trusts it. What that run may do depends on where it lands:
 *
 *   - No project on the card: it starts in this repository with read-only file
 *     tools, so it can move a card and read code but cannot change anything.
 *   - A project on the card: it starts in that directory and CAN EDIT AND RUN
 *     CODE THERE (MENTION_WATCH_PROJECT_TOOLS). Registering a directory as a
 *     project is therefore the act of granting write access to it — which is why
 *     registering one is a deliberate step and never inferred from a path in a
 *     comment.
 *
 * Either way the run sees ONLY the board MCP server (see scripts/lib/claude-run.ts),
 * so it cannot mail anyone, and either way it starts from now: requests already
 * sitting in the queue are left alone unless you pass --backlog.
 *
 * Widen either allowlist deliberately, not by default.
 */
// Relative, not "@automation/core": scripts/ sits outside the bun workspace, so
// the package alias is not resolvable here. Same reason `bun run typecheck` does
// not cover this file — see the note in README.
import {
  createLogger,
  getDb,
  getMention,
  listMentions,
  projectPathExists,
  releaseMention,
  resolveMention,
  USER_CLAUDE,
  type ActorContext,
  type MentionWithContext,
} from "../packages/core/src/index.ts";
import { argsFromEnv, boardServer, killActiveRuns, runClaude, writeMcpConfig } from "./lib/claude-run.ts";

const log = createLogger("mention-watch");

const ONCE = process.argv.includes("--once");
const DRY_RUN = process.argv.includes("--dry-run");
const BACKLOG = process.argv.includes("--backlog");

const INTERVAL_MS = Number(process.env.MENTION_WATCH_INTERVAL_MS ?? 5_000);
const TIMEOUT_MS = Number(process.env.MENTION_WATCH_TIMEOUT_MS ?? 600_000);
/**
 * A run that is actually changing code needs longer than one that is answering a
 * question about a card, so the two windows are separate rather than one number
 * stretched to fit the slower case.
 */
const PROJECT_TIMEOUT_MS = Number(process.env.MENTION_WATCH_PROJECT_TIMEOUT_MS ?? 1_800_000);
const CLAUDE_BIN = process.env.MENTION_WATCH_CLAUDE_BIN?.trim() || "claude";
const MODEL = process.env.MENTION_WATCH_MODEL?.trim() || "";
/** Read-only outside the board on purpose — see the header. */
const ALLOWED_TOOLS = process.env.MENTION_WATCH_ALLOWED_TOOLS?.trim() || "mcp__board Read Grep Glob";
/**
 * What a run gets when the card resolves to a project: the tools needed to
 * actually do the work in that checkout. Deliberately without the web tools —
 * a run that can read a private codebase and reach the network is a different
 * risk from one that can only change it, and adding them is one env var away.
 */
const PROJECT_TOOLS =
  process.env.MENTION_WATCH_PROJECT_TOOLS?.trim() ||
  "mcp__board Read Grep Glob Edit Write MultiEdit NotebookEdit Bash TodoWrite Task";
const EXTRA_ARGS = argsFromEnv(process.env.MENTION_WATCH_CLAUDE_ARGS);
/** Spawns per request before giving up and telling the human in the thread. */
const MAX_ATTEMPTS = Math.max(Number(process.env.MENTION_WATCH_MAX_ATTEMPTS ?? 2), 1);

/** The watcher's own writes are automation, not the model speaking. */
const watcher: ActorContext = { actorId: USER_CLAUDE, source: "system" };

const say = (message: string) => process.stderr.write(`${message}\n`);

/** The card, the ask, and where it sits. Identical wherever the run is spawned. */
function requestBlock(mention: MentionWithContext): string[] {
  return [
    "A request addressed to you was left in a comment on the shared kanban board.",
    "",
    `  request id : ${mention.id}`,
    `  the ask    : ${mention.request}`,
    `  full comment: ${mention.body}`,
    `  on task    : ${mention.taskId} — "${mention.taskTitle}"`,
    mention.taskDescription ? `  card detail: ${mention.taskDescription}` : null,
    `  state      : ${mention.columnName} (${mention.columnKind}), priority ${mention.taskPriority}`,
    `  board      : "${mention.boardName}" (${mention.boardId}), closes ${mention.boardEndsAt}`,
    `  asked by   : ${mention.requestedByName} at ${mention.createdAt}`,
  ].filter((line): line is string => line !== null);
}

const closingRules = [
  "You are running unattended — there is nobody to ask a follow-up question. If the request is",
  "ambiguous, take the most reasonable reading, do it, and state the assumption in the resolution.",
  "If it should not be done, resolve it as dismissed with the reason. If it needs a human, resolve it",
  "as dismissed explaining what you need. Do not finish while the request is still open.",
];

/**
 * The prompt for a card with no project: answer it from the board, reading this
 * repository if that is what the question needs.
 */
function buildPrompt(mention: MentionWithContext): string {
  return [
    ...requestBlock(mention),
    "",
    "Do this now, using the board MCP tools:",
    `  1. mention_claim ${mention.id} — returns the card and its full comment thread.`,
    "  2. Carry out what was asked. Use task_update / task_move / task_create / task_comment as needed;",
    "     if answering it means reading this repository, you have read-only file tools.",
    `  3. mention_resolve ${mention.id} with a one-line resolution of what you actually did.`,
    "     That text is posted back into the thread, so write it for the person who asked.",
    "",
    ...closingRules,
  ].join("\n");
}

/**
 * The prompt for a card that resolves to a project.
 *
 * The run has already been started *in* that directory, so this does not hand it
 * a path to go and find — it tells it where it is standing, and that the request
 * is about the code around it. Everything the run needs about the codebase comes
 * from the codebase itself (its CLAUDE.md, its files), which is exactly why the
 * work is delegated there rather than described from here.
 */
function buildProjectPrompt(mention: MentionWithContext): string {
  const project = mention.project!;
  return [
    ...requestBlock(mention),
    "",
    "YOU ARE RUNNING INSIDE THE CODEBASE THIS CARD IS ABOUT.",
    "",
    `  project  : ${project.name} [${project.slug}]`,
    `  directory: ${project.path}   <- your working directory, right now`,
    project.description ? `  what it is: ${project.description}` : null,
    `  attached : ${project.via === "task" ? "to this card specifically" : `to the whole "${mention.boardName}" board`}`,
    "",
    "Work here as you would in a normal session in this repository: read the code, find the",
    "actual cause, make the change, and check it the way this project checks things (its own",
    "CLAUDE.md and scripts apply to you). Do not rewrite from first principles what you can read.",
    "",
    "Do this now:",
    `  1. mention_claim ${mention.id} — returns the card and its full comment thread.`,
    "  2. Do the work in this directory.",
    `  3. mention_resolve ${mention.id} saying what you actually changed, naming the files.`,
    "     That text is posted into the card's thread and is all the person who asked will see,",
    "     so it has to stand on its own — 'done' tells them nothing they can check.",
    "",
    "Rules for this run:",
    "  - Do NOT commit, push, or open a pull request unless the request explicitly asked for it.",
    "    Leave the change in the working tree; the human reviews it.",
    "  - Stay inside this directory.",
    "  - If the request turns out to be about a different codebase than this one, do not guess:",
    "    resolve it as dismissed saying which project it looks like it belongs to.",
    "",
    ...closingRules,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Where this request runs and what it may do there.
 *
 * One decision, made in one place, because the three settings have to agree: a
 * run given write tools but started in this repository would edit the wrong
 * files, and a run started in a project but held to the read-only allowlist
 * could only describe the bug it was sent to fix.
 */
function dispatchFor(mention: MentionWithContext): {
  cwd: string | undefined;
  allowedTools: string;
  timeoutMs: number;
  prompt: string;
  where: string;
} {
  const project = mention.project;
  if (!project) {
    return {
      cwd: undefined,
      allowedTools: ALLOWED_TOOLS,
      timeoutMs: TIMEOUT_MS,
      prompt: buildPrompt(mention),
      where: "this repo, read-only",
    };
  }
  return {
    cwd: project.path,
    allowedTools: PROJECT_TOOLS,
    timeoutMs: PROJECT_TIMEOUT_MS,
    prompt: buildProjectPrompt(mention),
    where: `${project.slug} (${project.path})`,
  };
}

/** Spawns a run for one request and makes sure it does not end up in limbo. */
async function handle(mention: MentionWithContext, mcpConfig: string, attempt: number): Promise<void> {
  const dispatch = dispatchFor(mention);

  // A project whose directory has been moved or deleted cannot be run in, and
  // retrying will not bring it back. Say so on the card straight away rather than
  // burning both attempts on a cwd that does not exist.
  if (mention.project && !projectPathExists(mention.project.path)) {
    const reason = `the project directory ${mention.project.path} does not exist any more`;
    log.error("project directory missing", {
      mentionId: mention.id,
      taskId: mention.taskId,
      project: mention.project.slug,
      path: mention.project.path,
    });
    resolveMention(
      mention.id,
      {
        status: "dismissed",
        resolution: `could not run: ${reason}`,
        reply:
          `I could not pick this up: ${reason}, so there is nothing for me to work in. ` +
          `Point the "${mention.project.name}" project at the right directory (or detach it from this card) and ask again.`,
      },
      watcher,
    );
    say(`  ✗ ${mention.id}: ${reason}`);
    return;
  }

  log.info("dispatching request", {
    mentionId: mention.id,
    taskId: mention.taskId,
    attempt,
    request: mention.request.slice(0, 120),
    project: mention.project?.slug ?? null,
    cwd: dispatch.cwd ?? null,
  });
  say(`→ ${mention.id}  ${mention.request.slice(0, 90)}`);
  say(`    in ${dispatch.where}`);

  const result = await runClaude({
    prompt: dispatch.prompt,
    mcpConfig,
    allowedTools: dispatch.allowedTools,
    timeoutMs: dispatch.timeoutMs,
    cwd: dispatch.cwd,
    bin: CLAUDE_BIN,
    model: MODEL,
    extraArgs: EXTRA_ARGS,
  });
  const { seconds } = result;

  // The run was told to resolve the request itself. Whether it did is the real
  // outcome — a zero exit code with the request still open is still a failure.
  const after = getMention(mention.id);
  if (after.status === "answered" || after.status === "dismissed") {
    log.info("request handled", { mentionId: mention.id, status: after.status, seconds });
    say(`  ✓ ${after.status} in ${seconds}s — ${after.resolution ?? ""}`);
    return;
  }

  if (after.status === "claimed") {
    // It took the job and walked away. Record what it said so the thread is not
    // left silent, and hand the request back for another attempt.
    log.warn("run finished without resolving", { mentionId: mention.id, status: after.status, seconds, result });
    releaseMention(mention.id, `automated run ended without resolving (${seconds}s)`, watcher);
  } else {
    log.warn("run never claimed the request", { mentionId: mention.id, status: after.status, seconds, result });
  }

  if (attempt >= MAX_ATTEMPTS) {
    // Give up loudly. Silence here is the one outcome the human cannot act on.
    const note =
      `I could not complete this automatically after ${attempt} attempt(s), so it is still open. ` +
      `Last output: ${result.summary.slice(0, 800)}`;
    resolveMention(
      mention.id,
      { status: "dismissed", resolution: `automated handling failed after ${attempt} attempt(s)`, reply: note },
      watcher,
    );
    say(`  ✗ gave up after ${attempt} attempt(s); left a note on the card`);
  }
}

// --- main loop ---------------------------------------------------------------

getDb(); // migrate before the first poll, and fail fast on a broken database

const mcpConfig = writeMcpConfig("mention-watch.mcp.json", { board: boardServer() });
/** Requests older than startup are somebody else's business unless asked for. */
const startedAt = new Date().toISOString();
const attempts = new Map<string, number>();
/** Guards against a second spawn for a request the first pass is still running. */
const inFlight = new Set<string>();
let stopping = false;

say("");
say("  Mention watcher");
say(`  claude binary : ${CLAUDE_BIN}${MODEL ? ` (model ${MODEL})` : ""}`);
say(`  allowed tools : ${ALLOWED_TOOLS}`);
say(`  in a project  : ${PROJECT_TOOLS}`);
say(`                  a card with a project runs IN that directory and can change code there`);
say(`  mcp config    : ${mcpConfig} (board only, --strict-mcp-config)`);
say(`  scope         : ${BACKLOG ? "ALL pending requests, backlog included" : `requests created after ${startedAt}`}`);
say(
  `  poll / timeout: ${INTERVAL_MS}ms / ${Math.round(TIMEOUT_MS / 1000)}s per run ` +
    `(${Math.round(PROJECT_TIMEOUT_MS / 1000)}s in a project), ${MAX_ATTEMPTS} attempt(s) each`,
);
say(`  mode          : ${DRY_RUN ? "DRY RUN — nothing is spawned" : ONCE ? "one pass" : "watching"}`);
say("");
say("  Anyone who can reach the board can queue work here. Cloudflare Access is the boundary.");
say("");

async function pass(): Promise<void> {
  const pending = listMentions({ status: "pending", since: BACKLOG ? undefined : startedAt, limit: 50 });
  for (const mention of pending) {
    if (stopping) return;
    if (inFlight.has(mention.id)) continue;

    const attempt = (attempts.get(mention.id) ?? 0) + 1;
    if (attempt > MAX_ATTEMPTS) continue;
    attempts.set(mention.id, attempt);

    if (DRY_RUN) {
      const dispatch = dispatchFor(mention);
      say(
        `\n--- would spawn for ${mention.id} (attempt ${attempt}) ---\n` +
          `cwd: ${dispatch.cwd ?? "(this repo)"}\ntools: ${dispatch.allowedTools}\n\n${dispatch.prompt}\n`,
      );
      continue;
    }

    // Serial on purpose: two runs editing the same board at once is a worse
    // failure than a request waiting a minute.
    inFlight.add(mention.id);
    try {
      // Claiming is left to the spawned run so the audit trail reads honestly and
      // so a second watcher racing this one loses the claim rather than the work.
      await handle(mention, mcpConfig, attempt);
    } catch (error) {
      log.error("dispatch failed", { mentionId: mention.id, error });
      say(`  ! ${mention.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(mention.id);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    log.info("mention watcher stopping", { signal });
    // Each run lives in its own process group, so it does not get the terminal's
    // Ctrl-C for free — take it down explicitly rather than orphaning it.
    killActiveRuns();
    say("\nstopped.");
    process.exit(0);
  });
}
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));

log.info("mention watcher started", {
  scope: BACKLOG ? "backlog" : startedAt,
  intervalMs: INTERVAL_MS,
  allowedTools: ALLOWED_TOOLS,
  projectTools: PROJECT_TOOLS,
  dryRun: DRY_RUN,
});

await pass();
if (!ONCE && !DRY_RUN) {
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    await pass();
  }
}
