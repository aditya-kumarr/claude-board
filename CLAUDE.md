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
- **Deleting a column moves its tasks**, never deletes them, and a board must keep ≥1 column.
- **Positions are fractional** (`services/positions.ts`), so a reorder writes one row.
- Every mutation appends to `activity` inside the caller's transaction, recording `actor_id`
  and `source` (`web` | `mcp` | `system`).

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

`packages/web/src/lib/types.ts` deliberately duplicates the core wire types so the web build
stays standalone; keep the two in sync when changing an API shape.

## Frontend notes

React 18 + Vite + Tailwind v4 (CSS-first `@theme`, no JS config) with hand-written
shadcn-style primitives in `components/ui/`. Colours come from CSS variables only — semantic
`--kind-*` for column kinds and `--prio-*` for priorities, defined once per palette in
`index.css`. Do not hardcode a hex value in a component; add or reuse a token.

Drag-and-drop is native HTML5 (no dnd library). The drop index is computed from the pointer's
position against each card's midpoint in `board-column.tsx`.
