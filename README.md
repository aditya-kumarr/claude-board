# Board — a time-boxed kanban you and Claude share

A local Trello-ish board where **every board has a duration**. Pick a day, week, month,
quarter, year, or a custom end date, and that becomes a hard deadline: no task on the
board can be due after it, and a task created without its own due date inherits the
board's end.

Tasks move through per-board **states** (To do / Doing / Blocked / Needs review / Done by
default, and you can add your own), and each one is assigned to **you** or to **Claude**.
Anything assigned to Claude is work Claude is expected to actually do — it reads its queue,
moves cards as it progresses, and reports back in the card's comment thread over an
**MCP server**.

```
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│  React UI    │──HTTP──│  Express API │──┐     │  MCP server  │
│  (vite:5173) │        │  (:4000)     │  │     │  (stdio)     │
└──────────────┘        └──────────────┘  │     └──────────────┘
                                          ▼            │
                                   ┌─────────────┐     │
                                   │ bun:sqlite  │◀────┘
                                   │ data/       │  same file, WAL
                                   └─────────────┘
```

Both transports talk to the same SQLite file through one shared service layer, so Claude
can work whether or not the web server is running. Every write bumps a `revision` counter;
the UI polls it and refetches, which is how a card Claude moved appears in your browser a
couple of seconds later without any websockets.

## Running it

```bash
bun install
bun run db:seed        # optional: one example board
bun run dev            # API on :4000 and the UI on :5173
```

Then open <http://localhost:5173>.

Individually:

| Command | What it does |
| --- | --- |
| `bun run dev:server` | Express API on `:4000` (`--watch`) |
| `bun run dev:web` | Vite dev server on `:5173`, proxying `/api` to `:4000` |
| `bun run mcp` | MCP server on stdio (normally launched by Claude, not by hand) |
| `bun run build` | Build the UI; the API then serves it from `:4000` on its own |
| `bun run typecheck` | `tsc --noEmit` across all four packages |
| `bun run db:reset` | Delete the database and re-run migrations |
| `bun run db:seed` | Add a sample board (skips if it already exists) |

Configuration is via env vars — see `.env.example` for `PORT`, `WEB_PORT`,
`AUTOMATION_DB_PATH`, `AUTOMATION_LOG_DIR` and `LOG_LEVEL`.

## Letting Claude use the board

`.mcp.json` in the repo root already registers the server:

```json
{ "mcpServers": { "board": { "command": "bun", "args": ["run", "packages/mcp/src/index.ts"] } } }
```

Start `claude` from this directory and approve the server when prompted. Then just talk to
it: *"what's in your queue?"*, *"make me a board for this week"*, *"pick up the highest
priority task assigned to you"*.

### Tools it exposes

| | |
| --- | --- |
| `board_list` `board_create` `board_get` `board_update` `board_delete` `board_activity` | boards and their duration windows |
| `column_list` `column_add` `column_update` `column_delete` | states, including custom ones |
| `task_create` `task_get` `task_list` `task_update` `task_move` `task_comment` `task_delete` | tasks |
| `my_queue` | everything assigned to Claude, most urgent first — the main entry point |

Assignees accept natural aliases, so `"you"`, `"claude"` and `"agent"` all resolve to
Claude, and `"me"`, `"i"` and `"human"` to you. Columns resolve by id, key or name, so
`"needs review"` and `"needs_review"` both work.

## Logs

One file per ISO week under `logs/`, e.g. `logs/2026-W34.log`. A long-running process
reopens the file when the week rolls over, and weeks are numbered ISO-style, so the last
days of December land in the following January's file when that is where the week belongs.

```
2026-08-21T13:28:45.248+05:30 INFO  [http]   request completed {"requestId":"fdcee737","method":"GET","path":"/api/boards","status":200,"ms":2}
2026-08-21T13:30:12.004+05:30 INFO  [tasks]  task moved {"taskId":"tsk_jkuerfst","from":"todo","to":"doing","actor":"claude","source":"mcp"}
```

Every mutation records the `actor` and the `source` (`web`, `mcp` or `system`), so you can
always tell your changes from Claude's. The same information is in the `activity` table and
in the UI's Activity view. Console output goes to **stderr** only — stdout belongs to the
MCP JSON-RPC stream.

## Layout

```
packages/
  core/     domain layer — SQLite access, migrations, services, logger, duration maths
  server/   Express API over core + request logging and error mapping
  mcp/      stdio MCP server over core, with text renderers tuned for an agent to read
  web/      React + Vite + Tailwind v4 UI with hand-rolled shadcn-style components
data/       board.db (gitignored)
logs/       one .log per ISO week (gitignored)
```

`packages/core` holds every invariant — the board deadline, completion stamping when a card
enters a done-kind column, WIP limits, fractional card ordering — so the API and the MCP
server cannot drift apart on behaviour.
