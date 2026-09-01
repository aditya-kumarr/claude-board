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

Boards can also fill themselves: **Sync** reads your Outlook and Teams since it last looked and
adds a card for anything still waiting on you. See
[Pulling work in](#pulling-work-in-from-outlook-and-teams).

Work that does not arrive by mail can be **pasted**: a CSV export, the notes from a standup, a
forwarded thread, a photo of a whiteboard. Say what shape you want the cards in and get them.
See [Pasting things in](#pasting-things-in).

And because every one of those cards exists because somebody is waiting on you, each carries the
**replies you owe** — drafted by Claude while it still has the message in front of it. One to send
now, one for when the work is actually done, per person. Tweak them by telling Claude what to
change, or edit them by hand. See [Draft replies](#the-replies-you-owe).

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
bun run dev:all        # the above plus all four watchers, in one terminal
```

Then open <http://localhost:5173>.

`dev` and `dev:all` are Turborepo tasks (`turbo.json`), so every process starts in parallel
under one supervisor: one Ctrl-C stops all of them, and each line of output is prefixed with
the task it came from. `dev` deliberately stops at the API and the UI — the four watchers
spawn real `claude -p` runs, so starting them is a separate word you have to type.

Individually:

| Command | What it does |
| --- | --- |
| `bun run dev` | API + UI together (Turborepo) |
| `bun run dev:all` | API + UI + all four watchers together |
| `bun run dev:watchers` | Just the four watchers together |
| `bun run dev:server` | Express API on `:4000` (`--watch`) |
| `bun run dev:web` | Vite dev server on `:5173`, proxying `/api` to `:4000` |
| `bun run mcp` | MCP server on stdio (normally launched by Claude, not by hand) |
| `bun run build` | Build the UI; the API then serves it from `:4000` on its own |
| `bun run serve` | Build the UI and start the API serving it — one port, no Vite |
| `bun run tunnel` | Publish the board on its Cloudflare hostname (see below) |
| `bun run watch:mentions` | Act on `@claude` comments unattended (see below) |
| `bun run watch:sync` | Run queued Outlook/Teams syncs (see below) |
| `bun run watch:responses` | Rewrite draft replies you asked Claude to change (see below) |
| `bun run watch:intake` | Turn what you paste into a board's chat into cards (see below) |
| `bun run typecheck` | `tsc --noEmit` across all four packages, cached by Turborepo |
| `bun run db:reset` | Delete the database and re-run migrations |
| `bun run db:seed` | Add a sample board (skips if it already exists) |

Configuration is via env vars — see `.env.example` for `PORT`, `WEB_PORT`,
`AUTOMATION_DB_PATH`, `AUTOMATION_LOG_DIR` and `LOG_LEVEL`. Turborepo runs tasks with a
filtered environment, so a new env var only reaches a process once it is listed in
`globalPassThroughEnv` in `turbo.json` — add it there at the same time you add it to
`.env.example`, or the process will read `undefined` and fall back to its default.

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
| `sync_state` `sync_pending` `sync_request` `sync_claim` `sync_complete` `sync_cancel` | pulling work in from Outlook and Teams |
| `responses` `response_draft` `response_pending` `response_claim` `response_complete` `response_request` `response_cancel` | the replies each card owes (see below) |
| `intake_pending` `intake_claim` `intake_complete` `intake_cancel` | raw material pasted into a board's chat (see below) |

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
  passed with `--strict-mcp-config`, not the repo's `.mcp.json` — so it can never send mail or
  reach another server, and by default only read-only file tools on top of that, and
- it starts from **now**; requests already in the queue are left alone unless you ask for them.

The exception is a card with a **project** on it, which is the next section: that run starts in
your codebase and can change it.

Widen `MENTION_WATCH_ALLOWED_TOOLS` deliberately. See `.env.example` for the poll interval,
per-run timeout, and how many attempts a request gets before the watcher gives up and says so
on the card — because a request that fails quietly is worse than one that fails loudly.

## Projects: where the work actually happens

"Fix the duplicate button missing on the facility details page" is not a request this repository
can answer. It is answerable in the checkout where that page lives — so a card can name one.

A **project** is a directory on the machine running the board. Register it once from the sidebar
(name, path, and a line on what it is), then point a board at it — every card on that board
inherits it — or point one card somewhere else when it belongs to a different codebase:

```
Projects                  Facilities portal   ~/Code/facilities-portal
                          Billing API         ~/Code/billing-api

Board "This week"    →    Facilities portal          (the default for its cards)
  └─ card            →    Billing API                (this one only)
```

A card's project is **its own if it names one, otherwise its board's**. Nothing is copied when a
card is created, so re-pointing a board moves every card that never overrode it, and clearing a
card's project puts it back to inheriting rather than to nothing.

What that buys you: when you write `@claude` on a card with a project, the watcher spawns the run
**inside that directory**. It reads that repo's own `CLAUDE.md`, its files and its conventions —
so it starts from what the codebase actually is instead of from a description of it — and it sees
nothing outside it. The reply lands in the card's thread naming the files it changed.

> **Registering a directory is the act of granting write access to it.** A run delegated into a
> project gets `MENTION_WATCH_PROJECT_TOOLS` — file edits and `Bash` inside that directory — so it
> can genuinely fix the bug rather than describe it. It is told not to commit, push or open a PR
> unless the request asked for one, so the change is waiting in the working tree for you to review.
> Nothing infers a project from a path someone typed in a comment; it is always a deliberate step
> in the UI or an explicit `project_add`.

A project whose directory has been moved or deleted is not retried: the request is dismissed
straight away with the reason posted on the card, because a missing directory will not fix itself
in five seconds.

## Pulling work in from Outlook and Teams

Every board has a **Sync** button. It reads your mail and Teams messages and adds a card for
anything still outstanding — a direct ask, a question waiting on your answer, an approval sitting
with you — while skipping newsletters, notifications and CC-for-information.

It remembers where it got to. Each board keeps a watermark per source, so the second sync reads
only what arrived since the first one finished:

```
board_sync_state          outlook  ──synced through──▶  Tue 22:17
  (one row per source)    teams    ──synced through──▶  Tue 22:17
                                        │
              next run scans  (watermark, cutoff]  ── and only advances it if it succeeds
```

A failed run leaves the watermark where it was, so the window is re-read rather than skipped. A
board that has never synced starts from its own window, capped at 14 days back — pointing Sync at
a year-long board does not try to read a year of mail.

Nothing is imported twice. Each card records the message it came from in `sourceRef`, unique per
board, so re-running a sync over the same window is a no-op rather than a pile of duplicates.

### The button queues the work; it does not do it

Worth being clear about, because it explains the "Queued" state: the API process **cannot read
your mailbox**. It has no Microsoft Graph credentials, and the access that exists lives in the
Microsoft 365 MCP server — an agent's tool, not a library the server can call. So pressing Sync
records a request with a resolved time window, and Claude performs it.

Two ways that happens:

```bash
bun run watch:sync              # pick up queued syncs and run them
bun run watch:sync --dry-run    # print the prompt it would send, spawn nothing
bun run watch:sync --once       # one pass, then exit
```

…or just ask Claude in a session — `sync_pending` shows what is queued, and it can run it there.
Without either, a press sits at **Queued** until something picks it up, which the button's tooltip
says.

Unlike the mention watcher, this one takes on the queue that already exists when it starts: you
pressed a button and are watching a spinner, so leaving it for later would be wrong.

### Where Microsoft 365 access comes from

From your own **claude.ai Microsoft 365 connector** — the same one an interactive session uses. If
Claude can already read your mail when you talk to it, a sync can too, and there is nothing extra
to sign in to.

That has one consequence worth knowing, because it is the exception to how the mention watcher
works. A connector's credentials live with your account and cannot be written into a config file,
so a sync run is **not** given `--strict-mcp-config`: the generated config is merged with your own
rather than replacing it. The board server is still pinned in that generated config, so it keeps
opening the right database.

### What a sync run is allowed to do

The tool allowlist is therefore the real boundary, and it is drawn deliberately. The connector also
exposes `outlook_send_mail`, `outlook_forward_mail` and the rest, so a run is given an explicit
list of **read** tools rather than the whole server:

```
mcp__board                                          write cards
…__get_me  …__outlook_email_search
…__chat_message_search  …__teams_list_chats          read inboxes
…__outlook_calendar_search  …__read_resource
```

No file tools at all. A sync reads your inboxes and writes cards; it **cannot send mail, forward
anything, or post to Teams**, which for a job that only needs to read is pure downside removed.
Override with `SYNC_WATCH_ALLOWED_TOOLS` if you must, and note that widening it to
`mcp__claude_ai_Microsoft_365` hands an unattended run the ability to mail people as you.

If the connector is ever disconnected, a sync queues, attempts, and reports:

> Could not read Outlook or Teams … Watermark left unmoved so the full window is re-read next run.

Which is the system working: the watermark stays put, so nothing is skipped once it is reconnected
and you press Sync again.

## Pasting things in

Work rarely arrives as a task list. It arrives as a CSV somebody exported, the notes from a call, a
forwarded thread, a photo of a whiteboard. Every board has a **Paste** button for exactly that.

```
┌─ Make cards from anything ─────────────────────────────┐
│  you  One card per open row, assign by the owner       │
│       column, skip anything marked done                │
│       ▸ Pasted data · 40 rows × 5 columns              │
│       ▸ whiteboard.png  1.2 MB                         │
│                                                        │
│  ✦ Claude · 28 cards                                   │
│       Made 28 from the open rows. Skipped the 12       │
│       marked done, and the "TOTAL" row. Three had      │
│       due dates in October, outside this board's        │
│       window — left them off rather than moving your    │
│       deadline.                                        │
│       [Migrate auth tables] [Smoke-test SSO] [ … ]     │
└────────────────────────────────────────────────────────┘
```

Type into it, paste into it, drop files on it. A paste of more than a couple of lines goes into its
own block rather than the text box, so a 40-row CSV does not bury what you were typing. Screenshots
off the clipboard land as attachments. The cards it makes come back as chips you can click straight
through to.

**What it can read:** CSV, TSV, text, Markdown, JSON, YAML, logs, HTML, images and PDFs. Word and
Excel files are refused **when you drop them**, with the reason — they are zip archives, so nothing
here can read one, and saying so at the moment you drop it beats a run that fails five minutes later.
Export to CSV or PDF, or just paste the text.

### Only screenshots ever get file access

The nice property of this feature is where the boundary falls. Text you paste — and text files you
attach — are decoded **once, at upload**, and travel inside the prompt. So the common case gives the
spawned run the board and nothing else:

```
  pasted a CSV        →  mcp__board
  attached a PNG      →  mcp__board Read      ← for that one run only
```

The allowlist is computed per message rather than fixed per watcher, so pasting a spreadsheet never
hands an unattended run file access it has no use for. `INTAKE_WATCH_ALLOW_FILE_READS=false` refuses
it outright; a run given a screenshot then says it could not open it rather than inventing what it
said.

Sending **queues**, like everything else here that needs a model — the API process cannot read a CSV
into tasks. `bun run watch:intake` picks it up within a few seconds; without it, the paste waits
until Claude next reads the board. The composer locks while one message is in flight, because two
runs reading the same paste would create the cards twice.

### What it will not do

It will not invent work that was not in what you gave it, and it is told to say what it **skipped**
— a row already marked done, a totals line, a box on the whiteboard that was not a task. A due date
outside the board's window is left off and mentioned rather than quietly moved, because the board's
duration is a deadline and moving it is not Claude's call. And it is given the cards already on the
board, so a second paste of overlapping material updates or skips rather than duplicating.

## The replies you owe

A synced card is only half the work. Somebody mailed or messaged you, so the card says what you
have to do — and there is still a message you owe back. Every imported card carries drafts of it.

Two per person, written at the same time because they answer different moments:

```
  Send now              ▸ Priya Sharma          ▸ Rahul Menon  (Teams)
                          Re: Q3 audit numbers    Seen it — pulling the Q3
                          Hi Priya, I have the…   numbers now, should have…

  When it's done        ▸ Priya Sharma
  (waits for the card     Re: Q3 audit numbers
   to reach a done       Hi Priya, Q3 numbers…
   state)
```

The **Send now** reply is the one that stops a chaser mail: it confirms you have it and says what
happens next. The **when it's done** reply reports the outcome, and stays dimmed until the card
actually reaches a done state — at which point it lights up and the card badges itself.

Email and Teams are drafted differently, because they are different. An email has a subject line
and a sign-off; a Teams reply is one or two sentences with neither. Trying to give a chat message a
subject is an error, not something quietly dropped.

### Changing one

Click a box and the message opens in a panel over the card, with two ways to change it:

- **Tell Claude.** Type what you want different — "shorter", "push the date to Friday", "drop the
  last paragraph" — and it rewrites the whole message, changing nothing you did not ask about. The
  exchange stacks up under the draft, so you can see what you asked and what it did.
- **Edit it by hand**, for when saying what you want takes longer than typing it. A hand edit is
  recorded in the same thread, so the history reads as one story about the message.

Asking for a rewrite **queues** it, the same way Sync does and for the same reason — the API process
has no model access. The composer locks while one is in flight, because two rewrites of one message
from the same starting text is not something you can untangle afterwards. `bun run watch:responses`
is what turns a queued ask into new words within a few seconds; without it, the change waits until
Claude next reads the board.

If a run cannot do what you asked, the draft keeps its current text and the reason appears under
your instruction. Silence is the one outcome you cannot act on.

### Nothing here sends anything

Worth saying plainly, because it shapes the whole feature. There is no send endpoint, no Microsoft
Graph write scope anywhere in the repo, and no send tool in any watcher's allowlist. The reply-watcher
run gets the board MCP server and **nothing else** — no connector, no file access:

```
mcp__board                    read the card, rewrite the draft
                              (--strict-mcp-config: that is genuinely all it can see)
```

**I've sent this** records that *you* sent it, which is why **Copy** sits next to it and why the
status is terminal — there is no unsending a mail that has left. The value is having the right
words ready at the moment you need them; an unattended process able to mail your colleagues as you
is pure downside.

## When a board's time runs out

Nothing disappears when a deadline passes. The board drops out of the running list in the
sidebar into an **Expired** group underneath it, still openable, still holding whatever never
got finished — which is usually the reason you would look at it again. Expiry is not a stored
state, just the board's end date against the clock, so extending the window puts the board
straight back at the top.

Each expired row has an **archive** button on hover. That is the way out of the sidebar: the
board moves to the **Archive** page in the left-hand nav, where every archived board is listed
with its window, how long ago it closed, and how much of it got done. From there you can:

- **open** one and read its cards — an archived board is read-only in the sense that matters
  (no new cards, no paste, no sync), because those are the things the core layer refuses anyway;
- **restore** it, which puts it back in the sidebar exactly where it was;
- **delete** it, which is the one irreversible option here and asks first.

Archiving is also in the board's own `⋯` menu, and Claude can do it over MCP with
`board_update archived=true`. Nothing about it touches a card.

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
scripts/    tunnel + the four watchers (mentions, sync, replies, intake) — outside the
            workspace, so they import core by relative path
data/       board.db + intake/ attachments (gitignored)
logs/       one .log per ISO week (gitignored)
```

`packages/core` holds every invariant — the board deadline, completion stamping when a card
enters a done-kind column, WIP limits, fractional card ordering — so the API and the MCP
server cannot drift apart on behaviour.
