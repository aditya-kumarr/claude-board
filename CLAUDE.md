# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun run dev             # API :4000 + UI :5173 together
bun run dev:all         # the above plus all four watchers, one supervisor, one Ctrl-C
bun run dev:watchers    # just the four watchers together
bun run dev:server      # Express API only (bun --watch)
bun run dev:web         # Vite only; proxies /api to :4000
bun run typecheck       # tsc --noEmit over core, server, mcp, web
bun run build           # build the UI into packages/web/dist
bun run serve           # build + API serving the SPA on one port (:4000)
bun run tunnel          # publish :4000 on the Cloudflare hostname from TUNNEL_HOSTNAME
bun run watch:mentions  # spawn `claude -p` for each new @claude left in a comment
                        # --once / --dry-run / --backlog
bun run watch:sync      # spawn `claude -p` for each queued Outlook/Teams sync
                        # --once / --dry-run
bun run watch:responses # spawn `claude -p` for each queued change to a draft reply
                        # --once / --dry-run
bun run watch:intake    # spawn `claude -p` for each thing pasted into a board's chat
                        # --once / --dry-run
bun run db:reset        # drop data/board.db and re-migrate
bun run db:seed         # sample board; no-ops if it already exists
bun run mcp             # MCP server on stdio (Claude normally spawns this)
```

There is no test runner configured. Verify changes by running the stack and exercising the
API with `curl`, or by driving the MCP server over stdio with a small JSON-RPC script.

### Turborepo

`turbo.json` is the task graph. `dev`, `build` and `typecheck` are per-package tasks; `build`
and `typecheck` are cached and ordered by `dependsOn: ["^…"]`, and `dev` is `persistent` so
turbo holds it open instead of waiting on it. Three things about it are load-bearing:

- **The watchers are root tasks (`//#watch:mentions`, …), not a package.** `scripts/` stays
  outside the bun workspace for the reason it always has — it imports core by relative path —
  so the tasks hang off the *root* package's own scripts and the files do not move. That is
  what lets `dev:all` supervise the API, the UI and all four watchers as one run: one Ctrl-C
  stops the lot, and every line of output is prefixed with the task that wrote it.
- **`dev` does not start the watchers.** A watcher spawns real `claude -p` runs, so it is
  `dev:all` that starts them — a deliberate word, not the default of the command you type all
  day.
- **Turbo filters the environment.** Task env is strict, so anything the processes read must be
  listed in `globalPassThroughEnv` (wildcards allowed, hence `MENTION_WATCH_*` and friends).
  Adding a knob to `.env.example` without adding it there means the process silently reads
  `undefined` and takes its default. Pass-through rather than `globalEnv` because these are
  runtime knobs that must not invalidate the build/typecheck cache.

None of these tasks are marked `interactive`: turbo refuses an interactive task when stdout is
not a TTY, which would break `bun run dev` under `nohup`, a pipe or CI.

## Architecture

Bun workspace, four packages, one SQLite file.

**`packages/core` is the only place business rules live.** Both the Express API and the MCP
server are thin adapters over it — routes and tools do argument shaping and nothing else. A
rule implemented in a route handler is a bug, because the other transport will not have it.

Two processes hold their own connection to `data/board.db` (WAL, `busy_timeout=5000`). The
MCP server writes **directly to SQLite** rather than calling the HTTP API, so the agent works
whether or not the web server is up. Because of that, Express never sees the agent's writes as
traffic; instead `core.write()` bumps a `revision` counter in the `meta` table, the web client
polls `GET /api/meta/revision` every 2.5s, and refetches when it moves. Any new write path must
go through `write()` or the UI will not notice it.

### Invariants enforced in core

- **A board's duration is a deadline.** `resolveWindow()` in `lib/duration.ts` turns a
  `durationKind` into a concrete `[startsAt, endsAt]`. No task may be due after `endsAt`
  (`assertDueWithinBoard`), a task created without `dueAt` inherits `endsAt`, and shortening a
  board's window clamps any task that now falls outside it.
- **Column `kind`, not column name, drives behaviour.** Names are free-form and users add their
  own; `kind` (`backlog`/`active`/`blocked`/`review`/`done`) is what stats and completion read.
  `inferColumnKind()` guesses a kind from a new column's name. Entering a `done`-kind column
  stamps `completed_at`; leaving one clears it.
- **`@claude` in a comment is a request, not text.** `addCommentWithMentions()` parses the body
  in the one write path both transports share and inserts a `task_mentions` row per agent named,
  so the ask survives whether or not anyone is in a session. Two rules stop the loop feeding
  itself: only agent-kind users get a row, and an actor never enqueues a mention of *itself*, so
  Claude writing "@claude will follow up" is a note. `UNIQUE (comment_id, target_id)` makes the
  parse idempotent. Lifecycle is `pending → claimed → answered|dismissed`, and resolving posts
  the resolution back into the thread by default — a request answered with silence in the thread
  is indistinguishable from one that was ignored.
- **A run carrying out a request narrates it, and `task_comments.kind` is what makes that
  readable.** Resolving posts one comment at the end, which is fine for a question and useless for
  a half-hour run in a project: until it lands, a run that is working and a run that died look
  identical to the person watching the card. So the run comments as it goes, and each comment says
  what it *is* — `note` (the default, and everything a human writes), `progress` (a step: what is
  being done, what got done), `blocker` (it cannot go on, said mid-flight), `result` (written by
  `mention_resolve` whichever way the request went; answered-vs-dismissed is already carried by the
  mention's own status). The kind is a column rather than a prose convention for the reason the
  sync summary is structured: a blocker that reads as one more paragraph of narration is a blocker
  the user scrolls past, and it is the one comment in a thread asking *them* to do something.
  `task_comment` refuses `kind=result` — that one is `mention_resolve`'s to write. The contract is
  stated in **both** the watcher's prompt and `mention_claim`'s response, because a rule read at
  spawn time and a rule read at the moment of acting are not the same rule. The watcher writes the
  two comments only it can: a `blocker` when the project directory is gone or the attempts ran out,
  and a `progress` between attempts, so a thread that stops mid-sentence and starts over says why.
- **A sync watermark only moves on success.** `board_sync_state` holds one `synced_through` per
  (board, source); a run scans `(synced_through, cutoff]` and `completeSyncRun` advances it *only*
  for `status: "ok"`, so a failed or abandoned run re-reads its window instead of leaving a hole.
  `cutoff` is stamped when the run is **requested**, not when it finishes, so a mail arriving
  mid-run stays above the watermark rather than being stepped over. `imported` is attributed per
  source — a bare total across two sources is rejected rather than credited to both.
- **Outlook and Teams are not read on the same cadence, because a Teams read is not the same
  price.** Outlook has a real server-side search: one filtered query, paged. A *date-filtered*
  chat search has none, so the connector answers it by walking ~50 chats itself — one
  `chat_message_search` is ~50 Microsoft Graph requests, and it costs that whether the window is an
  hour or a fortnight. That single fact drives everything here. `SOURCE_POLICY` in `services/sync.ts`
  gives each source a `minIntervalMs` (Teams 2h, Outlook 0) and a `maxLookbackDays` (Teams 3,
  Outlook 14); `requestSync` drops a resting source from the scope **before** resolving windows and
  returns it in `skipped`, which the toast and `sync_request` both print — a Sync that quietly
  skipped Teams is indistinguishable from one that read it and found nothing. `force` is the
  deliberate override. Narrowing the window is *not* a mitigation, which is the counter-intuitive
  part: the scan visits every chat regardless, so only calling it less often helps.
- **Teams is therefore read in batches of chats, not in one sweep — and a pass spans runs.** The
  single `chat_message_search` above is cheap to *write* and unreliable to *run*: it gets throttled
  part way, comes back "searched 3 of 50 chats", and banks nothing. So a run lists chats once, reads
  a bounded batch of them (`SOURCE_POLICY.batchLimit`, Teams 10) newest-first via
  `teams:///chats/<id>/messages`, creates those cards, and reports the source `partial` with the ids
  it covered. The point is not that ~11 calls beats ~50; it is that the batch is **deterministic** —
  the run knows exactly which chats it read, so the work survives into the next run instead of being
  lost to a 429, and the newest threads become cards on the first run rather than after a full sweep.
- **`board_sync_state.progress` is the pass, and both ends of its window are frozen in it.** A pass
  starts at the watermark, ends at `passCutoff`, and takes as many runs as it takes; `passSince` is
  stored alongside because the watermark deliberately does *not* move until the pass finishes, so it
  cannot say where the pass began — without it a resuming batch resolves an empty window. `doneKeys`
  holds provider ids rather than a count or a cursor: the chat list reorders by recent activity
  between runs and a cursor can expire, but an id either was read or was not. `nextProgress` merges
  each run's keys into it, and `ok` clears the whole row's progress so the next pass starts clean.
- **A source with a pass in flight skips its own `minIntervalMs`.** `eligibility` returns null early
  for it. Finishing a pass already started is a different act from beginning one — the next batch is
  a fraction of a full scan, and making it serve Teams' 2h interval would turn one sweep into a day.
  A real `cooldown` from a 429 still applies, because that is the limit talking rather than policy.
- **`partial` is a fourth source outcome and is *not* a failure.** It holds the watermark exactly as
  `failed` does, but nothing went wrong: the run read its batch cleanly and has more to go, so it
  earns no cooldown, keeps the cards it made, and leaves the run's own `status` as `ok`. Only
  `failed` and `throttled` make a run read as broken. The column still stores `ok`/`failed`, so
  callers tell a mid-pass source from a broken one by `progress` being set — not by `lastStatus`.
- **`throttled` is a third source outcome, and the reason it exists is that a 429 is not
  retryable.** `sourceStatus` takes `ok | failed | throttled`; `throttled` holds the watermark back
  exactly as `failed` does and *additionally* stamps `board_sync_state.cooldown_until`, so the next
  press leaves that source alone instead of spending a fresh budget on the same wall. It is
  persisted rather than held in the watcher's memory because the limit belongs to the mailbox, not
  to the process that hit it — and because the watcher restarts. `completeSyncRun` also *infers* it
  from a detail that describes a rate limit while reporting a plain `failed`, but only when
  attribution is unambiguous (a single-source run, or a detail naming that source), since guessing
  would rest Outlook for a limit Teams hit.
- **The Teams lookback cap is the one place completeness is deliberately given up.** A source that
  keeps failing never advances its watermark, so its window widens daily — and for Teams a wider
  window is not merely slower, it is unfulfillable: the scan returns each chat's most recent
  messages and nothing older. `resolveScopeEntry` clamps a stale watermark to `maxLookbackDays` and
  records what it skipped in `SyncScopeEntry.cappedFrom`, which `sync_claim` prints as a note
  telling the run to name the gap in its `detail`. Clamping quietly would be the bug; the gap is
  real, so it is reported.
- **A draft reply is a draft, and nothing here ever sends one.** A synced card exists because
  somebody is waiting on the user, so `task_responses` holds the message they owe back — one row
  per correspondent per `stage`: `acknowledge` is the reply to send now, `completion` the one to
  send once the work is done. There is no send route, no Graph write scope and no send tool in any
  allowlist; `status: "sent"` is the *human* recording that they sent it, which is why it is
  terminal. `channel` is load-bearing rather than cosmetic — an email requires a subject (defaulted
  to `Re: <task title>`) and a chat message is rejected if given one, because a Teams box has no
  subject line. A `completion` draft's `dueNow` turns true only when its card reaches a `done`-kind
  column, which is the entire reason the two are separate drafts. The slot
  `(task, channel, recipient_ref, stage)` is unique among non-discarded rows, so a second drafting
  pass is a `conflict` naming `existingResponseId` rather than two versions of one reply.
- **`response_turns` is the queue and the chat transcript, because they are the same thing.** A
  pending turn is work waiting for an agent run; a finished one is a message in the thread the user
  reads under their draft. The API process has no model access, so typing "make it shorter" only
  records the ask (`202`, or `200` with `alreadyQueued` — two runs rewriting one message from the
  same starting text is not something the user can untangle). A hand edit is inserted as a turn
  that is already `done`, so the history is one story about the message rather than two interleaved
  ones. Finishing a `revise` turn without a body is rejected: the draft would keep its old text
  while the thread claimed it changed, which is the one outcome the user cannot see.
- **Pasted material is decoded at upload, not at read time.** A board's intake chat takes a CSV, a
  note, a thread or a screenshot; `intake_messages` is again the queue *and* the transcript. What is
  load-bearing is `intake_attachments.kind`: anything text-bearing is turned into a string in
  `services/intake.ts` when it arrives and travels **inline in the prompt**, so only an image or a
  PDF leaves a run something it has to open. That is what lets `scripts/watch-intake.ts` compute the
  allowlist **per message** — `mcp__board` alone for a pasted CSV, `Read` added for that one run when
  a screenshot is attached. A format that would store fine and then be unreadable (`.docx`, `.xlsx`,
  `.zip`) is refused *at upload* naming what to do instead, because a silently unusable attachment
  costs the user a whole round trip to discover. `completeIntakeMessage` verifies the task ids it is
  given against the board: the chat renders them as links, and a reply naming cards that are not
  there reads as work having been done when it was not.
- **A project is a directory, and a card's project is where its work happens.** `projects`
  holds absolute paths on this machine, validated at registration (`services/projects.ts`) rather
  than at delegation time — a typo comes back into the dialog the user is looking at instead of
  killing an agent run half an hour later. Both `boards` and `tasks` carry a nullable
  `project_id`, and the rule everything else leans on is one line: **a card's project is its own
  if it names one, otherwise its board's**. Nothing is copied at creation, so re-pointing a board
  moves every card that never overrode it, and clearing a card's project restores inheritance
  rather than meaning "none". `PROJECT_CONTEXT_COLUMNS` takes every field from the *same* side of
  a CASE rather than an `IFNULL` per column, or a card-level project with no description would
  borrow its board's project's description. That resolution rides on `MentionWithContext`, which
  is what makes it load-bearing: **an `@claude` on a card with a project is carried out inside
  that directory**, so registering one is the act of granting an unattended run write access to
  it — which is why it is a deliberate step in the UI and never inferred from a path in a comment.
- **A project cannot be archived, and deleting one deletes the work that pointed at it.** Archiving
  a project was the shape a board's archive has, and it was wrong for a directory: the row stayed
  invisible in the pickers while still holding its path in `idx_projects_path`, so the one thing a
  user does after retiring a directory — register it again — came back as *"already registered as
  ..."* naming a project they could no longer see. Migration 9 drops the column. That leaves delete
  as the only exit, so it is honest about its scope instead of the old `ON DELETE SET NULL`: it
  removes every board whose default project is this one (with its columns, cards and comments, by
  cascade) and every card that named the project *itself*, and `projectUsage()` is the read that
  names them all first. `deleteProject` **refuses without `confirmCascade`** whenever anything
  points at the project — a `conflict` carrying the boards and cards — which is what puts the same
  guard behind the UI's checkbox and behind a tool call. Nothing on disk is touched, and that is
  the point: the directory outlives the row, so registering it again has to work.
- **`tasks.source_ref` is what makes a sync re-runnable.** Unique per board via a partial index;
  `createTask` looks it up first so the caller gets a `conflict` naming `existingTaskId` instead
  of an opaque constraint violation or a duplicate card.
- **Deleting a column moves its tasks**, never deletes them, and a board must keep ≥1 column.
- **Positions are fractional** (`services/positions.ts`), so a reorder writes one row.
- Every mutation appends to `activity` inside the caller's transaction, recording `actor_id`
  and `source` (`web` | `mcp` | `system`).

`services/export.ts` owns *which* fields make a board legible outside the app, because that is a
domain decision both transports share — and it declares each field's closed value set next to the
data (`ExportField.options`), which is what lets the spreadsheet writer put a dropdown on State
holding exactly this board's columns rather than a list inferred from the values that happen to
appear. It builds CSV itself (needs nothing) and leaves XLSX to `server/src/lib/xlsx.ts`, the only
place with a dependency able to emit cell styles and data validation. `toCsv` prefixes a leading
`=`, `+`, `-` or `@` with an apostrophe: cards here are built out of mail and chat, so a subject
line of `=HYPERLINK(...)` is a live formula the moment the file is opened. **Nothing imports these
files back**, so the dropdowns are for reading and for the reader's own working, not a round trip.

`services/sync.ts` reads the two board fields it needs with its own query rather than importing
`getBoard`, because `getBoardDetail` embeds the sync summary and the import would close a cycle.
`services/intake.ts` and `services/responses.ts` read the task/board fields they need with their own
queries for the same reason `sync.ts` does: `getTaskDetail` embeds a card's replies and `getBoardDetail` embeds per-card counts,
so importing the task or board service there would close a cycle. `intake.ts` also owns the bytes on
disk: attachment rows store a path relative to `INTAKE_DIR`, never absolute, and deleting a message
removes its files — nothing else knows they are there.

`services/comments.ts` is a deliberate leaf: it owns comment persistence and imports neither
`tasks` nor `mentions`, which is what lets `addComment` (parses mentions out of what the human
wrote) and `resolveMention` (writes Claude's reply back) both append to a thread without the two
services importing each other.

### Assignees

Two seeded rows, `me` (human) and `claude` (agent), inserted before any board exists.
`requireUser()` resolves natural aliases — `you`/`agent`/`assistant` → `claude`, `i`/`myself`/
`human` → `me` — so the MCP tools accept whatever a conversation produces. Tasks assigned to
`claude` are work Claude is expected to actually do.

### Logging

`core/src/lib/logger.ts` writes one file per ISO week to `logs/<year>-W<week>.log`, holding an
append-mode fd and reopening it when the week rolls over. **Console output goes to stderr
only** — stdout is the MCP JSON-RPC stream, and a stray line there corrupts the protocol. Use
`createLogger(scope)` and `.child({...})` to bind request context rather than formatting ids
into messages. `LOG_LEVEL` gates output; `/api/health` and `/api/meta/revision` log at `debug`
so the UI's poll does not flood the file.

### Errors

Throw `AppError` subclasses (`badRequest`, `notFound`, `conflict`) from core. The Express
`errorHandler` maps them to `{ error: { code, message, details } }`; the MCP `handler()` wrapper
returns them as tool content with `isError: true` so the model can read what went wrong and
retry rather than seeing an opaque protocol failure. Anything else becomes a logged 500.

### MCP specifics

Tools are registered in `packages/mcp/src/tools.ts` with zod input schemas. Tool responses are
**human-readable text**, not JSON — `format.ts` renders boards, queues and task detail in a
layout dense enough that one call is usually enough to act on. Descriptions carry the rules the
model needs at selection time (that due dates are bounded by the board, that `my_queue` is the
entry point), because a tool description is the only documentation the model gets.

The mention inbox is surfaced in three places on purpose, because a queue the model has to
remember to check is a queue it will not check: `mentions`/`mention_claim`/`mention_resolve` are
the explicit tools, `my_queue` leads with a banner of anything pending, and `board_get` /
`board_list` / `task_get` mark which cards are waiting. `mention_claim` returns the card and the
whole thread so one call is enough to act.

`responses` / `response_pending` / `response_claim` / `response_draft` / `response_complete` are the
draft-reply tools, surfaced the same way the mention inbox is and for the same reason: `my_queue`
leads with a banner of queued reply changes, `board_get` marks which cards have replies waiting, and
`task_get` lists a card's drafts above its comments — on a card that came out of somebody's mail the
reply owed back is the point of the card, not a footnote. `response_claim` returns the instruction,
the current message in full and the card, so one call is enough to act.

`board_export` renders the board as CSV. It is deliberately *not* the way to read a board — one
card's worth of prose per row makes it far bulkier than `board_get` — so its description says as
much, and points at the UI for the `.xlsx` version it cannot produce.

`project_list` / `project_add` / `project_update` / `project_usage_check` / `project_delete` register
the directories work can be delegated into; a card or board is pointed at one through `task_update` /
`board_update`'s `project` argument rather than a tool of its own, because attaching is an edit to the
card. Every render that a run acts on — `board_get`, `task_get`, `mention_claim` — carries the
resolved path and says whether the directory still exists, since a stale path is otherwise discovered
only as a failure the model cannot diagnose. There is no `archived` argument, because a project has no
such state; `project_delete` takes the project's boards and cards with it and needs `confirmCascade`,
which is why `project_usage_check` exists — it names the boards and cards in the user's own words so
the model can ask before spending them rather than reporting a count afterwards. A directory that has
merely *moved* is a `project_update path=…`, not a delete.

`intake_pending` / `intake_claim` / `intake_complete` are the intake tools, and `my_queue` carries a
third banner for them. `intake_claim` is the widest job spec in the server: the pasted text in full,
the contents of every text attachment, the on-disk path of anything needing `Read`, the board's
states and deadline, **and the cards already on the board** — because the commonest way to get this
wrong is to re-import work that is already there.

### Board intake

### Draft replies

`sync_claim` tells the run to draft replies for every card it imports, in the same run. That timing
is the design and not an optimisation: the mail body is in front of the model at import time and
never again, so a reply drafted later can only work from whatever made it into the card description.
Two drafts per correspondent — `acknowledge` and `completion` — written together while the context
exists, with the completion one surfacing later when the card is done.

The UI shows them as boxes on the card, each with the first lines of the actual message, because a
box that had to be opened to be worth anything means one click per card to find the one needing work.
Opening a box slides a sheet over the dialog: the message is the hero, with a chat box under it and a
manual editor behind one button. Both routes to a change land in the same thread.

### Inbox sync

`Sync` on a board pulls pending work out of Outlook and Teams. The Express process **cannot do
this** — it holds no Microsoft Graph credentials, and the access that exists lives in the MS365
MCP server, which is an agent's tool rather than a library. So `POST /api/boards/:id/sync` only
*queues* a request (`202`, or `200` with `alreadyQueued` when one is already outstanding) and an
agent run performs it: `sync_pending` → `sync_claim` → read with the MS365 tools → `task_create`
with `sourceRef` → `sync_complete`.

`sync_claim`'s response is the spec for the job, not a summary of it: it carries the per-source
window, the board's columns, and the rules for what counts as a task. That is deliberate — the
model gets those rules at the moment it acts, rather than depending on the prompt that spawned it.

### The watchers

`scripts/watch-mentions.ts`, `scripts/watch-sync.ts`, `scripts/watch-responses.ts` and
`scripts/watch-intake.ts` are the push half: they poll their queue and spawn a real `claude -p` run per item. All four live in `scripts/`,
outside the bun workspace, so they import core by **relative path**
(`../packages/core/src/index.ts`) and are not covered by `bun run typecheck` — same as
`scripts/tunnel.ts`.

`scripts/lib/claude-run.ts` owns the spawn, because the risky parts are identical in both and
should only be got right once:

- Each run gets a **generated** MCP config holding the servers it needs; the repo's `.mcp.json` is
  never passed through as-is. The mention watcher gets the board server only, plus
  `--strict-mcp-config` so that is genuinely all it can see.
- **The sync watcher is the one exception to strict.** Microsoft 365 access comes from the user's
  claude.ai connector, whose credentials live with their account and cannot be written into a
  config file — so `strictMcpConfig: false` merges the generated config with the ambient one
  instead of replacing it. Claude Code does surface account connectors to `claude -p`; the board
  server stays pinned in the generated config so it still opens the right database.
- That makes `--allowedTools` the real boundary for a sync, so it lists **individual** connector
  tools (`…__outlook_email_search`, `…__teams_list_chats`, …) rather than the `mcp__claude_ai_Microsoft_365`
  prefix. Allowing the prefix would also hand an unattended run `outlook_send_mail` and
  `outlook_forward_mail`. Keep that list read-only.
- **`CLAUDE_CONFIG_DIR` is unset in the child, not inherited.** That variable picks the
  `.claude.json` the CLI reads, and that file carries the *account* — so it decides which
  claude.ai connectors exist. A `CLAUDE_CONFIG_DIR` exported in a shell profile therefore
  silently chooses whose Outlook a sync reads, and a config dir holding a second account has no
  Microsoft 365 connector at all. From inside the run that is indistinguishable from an outage:
  it can only report "no Outlook/Teams tools", never "wrong account" — which is why the sync
  watcher's banner prints the resolved account and config dir. `WATCH_CLAUDE_CONFIG_DIR` picks a
  non-default one deliberately. Note that *unsetting* it is not the same as setting it to `~`:
  when it is exported the CLI also looks for credentials beside the config file, so pinning the
  default path by value yields `Not logged in` from an account that is signed in.
- Runs are spawned `detached` in their own process group and killed as a group. Signalling only
  the run leaves its MCP servers alive holding its stdout pipe, which is how a 300s timeout once
  took 534s to return. For the same reason the result is reported on `exit`, not `close`.
- Because a detached run does not receive the terminal's Ctrl-C, both watchers call
  `killActiveRuns()` from their signal handlers rather than orphaning a run mid-flight.

The mention watcher is the one that decides **where** a run happens. `dispatchFor()` resolves
the card's project and returns the working directory, the tool allowlist and the timeout as one
decision, because the three have to agree: a run given write tools but started in this repo would
edit the wrong files, and a run started in a project but held to the read-only allowlist could
only describe the bug it was sent to fix. With no project it is unchanged — this repo, `mcp__board
Read Grep Glob`. With one it starts in that directory with `MENTION_WATCH_PROJECT_TOOLS` (file
edits and `Bash`, deliberately no web tools) and a longer window, and picks up that project's own
`CLAUDE.md` for free — which is the entire point, and why the prompt tells it where it is standing
rather than handing it a path to go and find. `--strict-mcp-config` still applies, so the project's
own `.mcp.json` is not reachable. A project whose directory has been moved is **not** retried: the
run is dismissed immediately with the reason posted on the card, because a missing cwd will not fix
itself in five seconds.

The sync watcher's allowlist has one omission that is about cost rather than safety:
**`teams_list_chats` is not in it.** A date-filtered `chat_message_search` already spans every chat,
so enumerating chats and searching them one by one reads the same messages several times over and is
the reliable way to earn a 429. The prompt says so too, but a prompt is advice and an allowlist is
not — and per-chat thoroughness is exactly the shape of drift this needs to be safe from. Chat ids
for `recipientRef` come out of the search results. The watcher also mirrors core's per-source
cooldown into an in-process map, because Graph's limits are per **mailbox**: a 429 on one board's
Teams has spent every other board's Teams budget too, which core — keyed by (board, source) — cannot
see. It holds a queued run only when *every* source in its scope is resting, so a mixed run still
gets dispatched for the Outlook half.

The sync watcher also *continues* a pass on its own: after a run that leaves `progress` behind and
with nothing resting, `continuePass` queues the next batch, so "newest threads first, then the rest"
happens without the user pressing Sync again. It is guarded on `scanned` actually having grown —
a batch that read no new chats stops the loop rather than queueing for ever — and capped by
`SYNC_WATCH_MAX_CONTINUATIONS`.

`scripts/watch-responses.ts` is the strictest of the three, because rewriting a message needs the
board and nothing else: board server only, `--strict-mcp-config`, and `mcp__board` as its entire
allowlist — no connector, no file tools. A run that ends without calling `response_complete` is
released for another attempt and then failed with the run's last output as the note, so the reason
lands under the user's instruction. Like the sync watcher it works the queue that exists at startup,
for the same reason.

`scripts/watch-intake.ts` is the only one whose allowlist is not a constant. `toolsFor(message)`
returns `mcp__board` when everything pasted was inlined at upload, and adds `Read` only for a message
carrying a screenshot or a PDF — least privilege per paste rather than one allowlist wide enough for
the worst case. `INTAKE_WATCH_ALLOW_FILE_READS=false` withholds it entirely, in which case a run
reports that it could not open the attachment instead of inventing what it said.

The sync watcher differs from the mention watcher in one deliberate way: it processes the queue
that already exists at startup. A queued sync is something the user pressed a button for and is
watching a spinner for, so deferring it would be wrong — whereas an old mention is somebody
else's business unless `--backlog` says otherwise.

Three things about it are load-bearing rather than incidental:

- It writes its own `data/mention-watch.mcp.json` holding **only** the board server and passes
  `--strict-mcp-config`, so an unattended run triggered by a web form cannot reach the repo's
  other MCP servers. `AUTOMATION_DB_PATH` is pinned into that config, not inherited, or the
  spawned server would answer requests against a different database.
- It does **not** claim the mention itself — the spawned run does. That keeps the audit trail
  honest (`claimed by claude via mcp`) and makes a second watcher lose the claim rather than the
  work. An in-process in-flight set stops the same watcher double-spawning.
- A run that exits without resolving is a failure even on exit code 0. The watcher re-reads the
  status, releases the mention for another attempt, and after `MENTION_WATCH_MAX_ATTEMPTS`
  dismisses it with the run's last output posted to the card. Silence is the one outcome the
  human cannot act on. The sync watcher applies the same rule: a run that ends without calling
  `sync_complete` is marked `failed`, which leaves the watermark unmoved *and* puts the reason on
  the board, rather than leaving the UI showing a sync that never ends.

`packages/web/src/lib/types.ts` deliberately duplicates the core wire types so the web build
stays standalone; keep the two in sync when changing an API shape. `components/mention-text.tsx`
carries a copy of core's mention regex for highlighting — the two must agree, or the UI paints a
mention the parser then ignores.

## Frontend notes

React 18 + Vite + Tailwind v4 (CSS-first `@theme`, no JS config) with hand-written
shadcn-style primitives in `components/ui/`. Colours come from CSS variables only — semantic
`--kind-*` for column kinds and `--prio-*` for priorities, defined once per palette in
`index.css`. Do not hardcode a hex value in a component; add or reuse a token.

Drag-and-drop is native HTML5 (no dnd library). The drop index is computed from the pointer's
position against each card's midpoint in `board-column.tsx`.

**Claude's comments are markdown; the human's are not.** `components/markdown.tsx` parses the
subset an agent writing a status update actually uses — headings, nested lists, fenced and inline
code, tables, quotes, links — and is hand-written for one reason that is not taste: mention
highlighting has to happen *inside* the text nodes, and the regex doing it must stay the single
copy that agrees with core's parser, so `mention-text.tsx` exports the split and the markdown
renderer calls it on every run of plain text. A human's note stays plain text with mentions picked
out: they type into a box with no formatting affordance and no preview, so reinterpreting their
asterisks would be a change they did not ask for. The thread also refetches on `revisionKey`
rather than on `task.updatedAt` — a comment does not touch the task row, so keying it off the
card's own timestamp meant a run's progress never reached the dialog the user had open while it
worked.

**The Sync settings panel configures one press, not a stored preference.**
`sync-settings.tsx` picks the sources, optionally overrides the start date, and can force past a
rest — all arguments to the next `requestSync` and nothing more. The durable equivalents already
exist and are better: the watermark decides where a normal sync starts and `SOURCE_POLICY` decides
how often each source is read, so a saved "always read Teams from the 1st" would quietly fight
both. `BoardSyncSummary.skips` is what makes the panel honest — it runs the *same* `eligibility`
the request path uses, so the panel and the button can never disagree about what a press will do,
and "when can I retry" is answerable without pressing Sync to find out. The result is bulleted
because the facts live in two places: which watermarks moved and what is resting come from
per-source state, while the prose comes from the run's `detail`, and neither alone answers "what
happened".

**Expired and archived are different things, and the sidebar says so.** A board whose `endsAt`
has passed drops into the sidebar's own *Expired* group — nothing is written to say so, it is
the board's `endsAt` against the clock, so extending a window brings it straight back up. The
group carries a per-row archive button, which is the only way out of the list short of deleting.
*Archived* is the stored flag, and those boards live on the `archive` view (`archive-view.tsx`)
with restore and delete. `useBoards` therefore fetches `includeArchived=true` and splits the two
lists itself rather than having the archive page poll separately, which is also what keeps the
sidebar's archive count honest. An archived board is **openable** from there — `App`'s
board-not-found fallback checks `allBoards`, so it is deletion and not archiving that bounces the
view — and reading one is the point of keeping it, so the header and columns disable only what
core would refuse anyway (a new card, a paste, a sync).
