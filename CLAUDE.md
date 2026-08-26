# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun run dev             # API :4000 + UI :5173 together
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
bun run db:reset        # drop data/board.db and re-migrate
bun run db:seed         # sample board; no-ops if it already exists
bun run mcp             # MCP server on stdio (Claude normally spawns this)
```

There is no test runner configured. Verify changes by running the stack and exercising the
API with `curl`, or by driving the MCP server over stdio with a small JSON-RPC script.

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
- **A sync watermark only moves on success.** `board_sync_state` holds one `synced_through` per
  (board, source); a run scans `(synced_through, cutoff]` and `completeSyncRun` advances it *only*
  for `status: "ok"`, so a failed or abandoned run re-reads its window instead of leaving a hole.
  `cutoff` is stamped when the run is **requested**, not when it finishes, so a mail arriving
  mid-run stays above the watermark rather than being stepped over. `imported` is attributed per
  source — a bare total across two sources is rejected rather than credited to both.
- **`tasks.source_ref` is what makes a sync re-runnable.** Unique per board via a partial index;
  `createTask` looks it up first so the caller gets a `conflict` naming `existingTaskId` instead
  of an opaque constraint violation or a duplicate card.
- **Deleting a column moves its tasks**, never deletes them, and a board must keep ≥1 column.
- **Positions are fractional** (`services/positions.ts`), so a reorder writes one row.
- Every mutation appends to `activity` inside the caller's transaction, recording `actor_id`
  and `source` (`web` | `mcp` | `system`).

`services/sync.ts` reads the two board fields it needs with its own query rather than importing
`getBoard`, because `getBoardDetail` embeds the sync summary and the import would close a cycle.
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

`scripts/watch-mentions.ts` and `scripts/watch-sync.ts` are the push half: they poll their queue
and spawn a real `claude -p` run per item. Both live in `scripts/`, outside the bun workspace, so
they import core by **relative path** (`../packages/core/src/index.ts`) and are not covered by
`bun run typecheck` — same as `scripts/tunnel.ts`.

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
- Runs are spawned `detached` in their own process group and killed as a group. Signalling only
  the run leaves its MCP servers alive holding its stdout pipe, which is how a 300s timeout once
  took 534s to return. For the same reason the result is reported on `exit`, not `close`.
- Because a detached run does not receive the terminal's Ctrl-C, both watchers call
  `killActiveRuns()` from their signal handlers rather than orphaning a run mid-flight.

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
