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

Comments run the other way too: write **`@claude`** on a card and the comment becomes a tracked
request, which Claude picks up, carries out, and answers in the thread — optionally without you
being there at all. See [Asking Claude for something](#asking-claude-for-something-claude).

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
| `bun run serve` | Build the UI and start the API serving it — one port, no Vite |
| `bun run tunnel` | Publish the board on its Cloudflare hostname (see below) |
| `bun run watch:mentions` | Act on `@claude` comments unattended (see below) |
| `bun run typecheck` | `tsc --noEmit` across all four packages |
| `bun run db:reset` | Delete the database and re-run migrations |
| `bun run db:seed` | Add a sample board (skips if it already exists) |

Configuration is via env vars — see `.env.example` for `PORT`, `WEB_PORT`,
`AUTOMATION_DB_PATH`, `AUTOMATION_LOG_DIR` and `LOG_LEVEL`.

## Reaching it from a phone or tablet

The board runs on this machine, but a tablet cannot use `localhost` and chasing the LAN
address every time DHCP moves it gets old fast. `bun run tunnel` puts it behind a stable
Cloudflare hostname instead, so the URL on the iPad never changes.

Be clear about what this is: a Cloudflare Tunnel is an **outbound** connection to
Cloudflare's edge. Traffic leaves the network, reaches Cloudflare, and comes back down the
tunnel — so the hostname is genuinely public, and the tunnel is *not* what keeps strangers
out. **Cloudflare Access in front of it is.** `bun run tunnel` probes for that policy and
refuses to start without one.

One-time setup:

1. `cloudflared tunnel login` and pick a zone you own.
2. Put the hostname in `.env`:

   ```
   TUNNEL_HOSTNAME=board.yourdomain.com
   ```

3. In the Zero Trust dashboard, **Access → Applications → Add a self-hosted application**,
   with that hostname as the domain and one policy:

   | | |
   | --- | --- |
   | Action | Allow |
   | Include | Emails → your address |

   Everything else is blocked by default. Access emails a one-time PIN, which works in
   Safari on iOS and Chrome on Android with nothing installed. Do **not** gate this by IP:
   a home IP moves, which is the problem you were trying to escape.

Then, from two terminals:

```bash
bun run serve     # build the UI + API on :4000
bun run tunnel    # create/reuse the tunnel, point DNS at it, run it
```

`tunnel` creates the named tunnel if it is missing, points the DNS record at it, writes
`cloudflared/config.generated.yml`, and runs `cloudflared`. It never overwrites a DNS record
that already points elsewhere — it tells you the `--overwrite-dns` command instead.

Because `serve` puts the API and the built SPA on one origin and the client calls `/api`
relatively, there is exactly one ingress rule and no base-URL or CORS configuration.

### Without Cloudflare

On the same wifi, skip the tunnel entirely:

```bash
HOST=0.0.0.0 bun run serve
```

The board is then at `http://<this-machine-lan-ip>:4000`. Nothing leaves the network, but
there is no TLS and no stable name — give the machine a DHCP reservation if you go this way.

### Dev server over the tunnel

`bun run serve` is the better default because a production build has no host checks or
websockets to worry about. If you do want hot reload on the tablet, `TUNNEL_HOSTNAME` also
allow-lists the host in Vite and points HMR at `wss://<hostname>:443`; run `bun run dev` and
change the tunnel's ingress to `:5173`.

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
| `mentions` `mention_claim` `mention_resolve` `mention_release` | the `@claude` inbox (see below) |

Assignees accept natural aliases, so `"you"`, `"claude"` and `"agent"` all resolve to
Claude, and `"me"`, `"i"` and `"human"` to you. Columns resolve by id, key or name, so
`"needs review"` and `"needs_review"` both work.

## Asking Claude for something: `@claude`

Write `@claude` in a card's comment and it stops being a note. Core parses the comment on the
way in and records the ask as a tracked request with its own lifecycle:

```
pending  ──mention_claim──▶  claimed  ──mention_resolve──▶  answered
                                                        └─▶  dismissed
```

That row is the point. A comment is easy to miss and impossible to audit; a request has a
status, so an ask left from the tablet at midnight is still sitting in Claude's inbox in the
morning rather than depending on someone having been in a session when it was written.

Two rules keep it from feeding itself: only agent-kind users get a request row, so `@me` is
prose, and nobody ever enqueues a mention of *themselves* — Claude writing "@claude will follow
up on this" is a note, not a new job.

Resolving a request posts the resolution back into the thread by default, because a request
answered with silence on the card looks exactly like one that was ignored.

**On Claude's side**, the inbox is deliberately hard to miss: `mentions` lists what is open,
`my_queue` leads with a banner of anything pending, and `board_get`, `board_list` and
`task_get` all mark which cards are waiting. `mention_claim` returns the ask, the card and the
whole thread in one call, so there is nothing to look up before acting.

**On yours**, a card with an unanswered ask is badged on the board, in the header count, and in
the thread — where each of your comments shows whether the request it raised is waiting, in
progress, or answered.

### Making it happen without you

Everything above works whenever Claude next reads the board. To have a request handled *now*:

```bash
bun run watch:mentions              # watch for new requests and act on them
bun run watch:mentions --dry-run    # print the prompts it would send, spawn nothing
bun run watch:mentions --once       # one pass, then exit
bun run watch:mentions --backlog    # also pick up requests older than startup
```

It polls for pending requests and spawns a real `claude -p` run for each one, which claims the
request, does the work through the board tools, and resolves it — so the answer appears in the
thread you wrote in.

Be clear about what this process is. It runs an agent with tool access on input typed into a
form that, behind `bun run tunnel`, is reachable from the internet. **Whoever can reach the
board can queue work here**, and the Cloudflare Access policy is the thing deciding who that is;
the watcher trusts that decision. Two defaults keep the blast radius small:

- the spawned run sees **only** the board MCP server — a generated `data/mention-watch.mcp.json`
  passed with `--strict-mcp-config`, not the repo's `.mcp.json` — plus read-only file tools, so
  it can move a card and read this codebase but cannot edit files or send mail, and
- it starts from **now**; requests already in the queue are left alone unless you ask for them.

Widen `MENTION_WATCH_ALLOWED_TOOLS` deliberately. See `.env.example` for the poll interval,
per-run timeout, and how many attempts a request gets before the watcher gives up and says so
on the card — because a request that fails quietly is worse than one that fails loudly.

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
scripts/    tunnel + mention watcher — outside the workspace, so they import core by path
data/       board.db (gitignored)
logs/       one .log per ISO week (gitignored)
```

`packages/core` holds every invariant — the board deadline, completion stamping when a card
enters a done-kind column, WIP limits, fractional card ordering — so the API and the MCP
server cannot drift apart on behaviour.
