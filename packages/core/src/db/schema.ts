/**
 * Ordered, append-only migrations. Each entry runs once inside a transaction
 * and is recorded in `schema_migrations`; never edit a shipped statement, add a
 * new one instead.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: /* sql */ `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('human','agent')),
        created_at    TEXT NOT NULL
      );

      CREATE TABLE boards (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        duration_kind TEXT NOT NULL CHECK (duration_kind IN ('day','week','month','quarter','year','custom')),
        starts_at     TEXT NOT NULL,
        ends_at       TEXT NOT NULL,
        archived      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE board_columns (
        id         TEXT PRIMARY KEY,
        board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('backlog','active','blocked','review','done')),
        position   REAL NOT NULL,
        wip_limit  INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (board_id, key)
      );

      CREATE TABLE tasks (
        id             TEXT PRIMARY KEY,
        board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        column_id      TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        description    TEXT,
        assignee_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_by     TEXT NOT NULL REFERENCES users(id),
        priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
        due_at         TEXT,
        position       REAL NOT NULL,
        completed_at   TEXT,
        blocked_reason TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_board    ON tasks (board_id, column_id, position);
      CREATE INDEX idx_tasks_assignee ON tasks (assignee_id, completed_at);
      CREATE INDEX idx_tasks_due      ON tasks (due_at);

      CREATE TABLE task_comments (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id  TEXT NOT NULL REFERENCES users(id),
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_comments_task ON task_comments (task_id, created_at);

      CREATE TABLE activity (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id   TEXT,
        task_id    TEXT,
        actor_id   TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        source     TEXT NOT NULL CHECK (source IN ('web','mcp','system')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_activity_board ON activity (board_id, id DESC);
      CREATE INDEX idx_activity_task  ON activity (task_id, id DESC);

      -- Single-row counter bumped by every write. The web client polls it so it
      -- can pick up changes the agent made directly through the MCP server.
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO meta (key, value) VALUES ('revision', '0');
    `,
  },
  {
    version: 2,
    name: "task_mentions",
    sql: /* sql */ `
      -- An @claude in a comment is a *request*, not decoration: it gets its own
      -- row with a lifecycle so nothing the human asked for is silently dropped.
      -- The request text is not copied here; it is the comment this points at.
      CREATE TABLE task_mentions (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        comment_id   TEXT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
        target_id    TEXT NOT NULL REFERENCES users(id),
        requested_by TEXT NOT NULL REFERENCES users(id),
        status       TEXT NOT NULL CHECK (status IN ('pending','claimed','answered','dismissed')),
        source       TEXT NOT NULL CHECK (source IN ('web','mcp','system')),
        claimed_at   TEXT,
        resolved_at  TEXT,
        resolution   TEXT,
        created_at   TEXT NOT NULL,
        -- One request per comment per target, so re-parsing a comment or writing
        -- "@claude ... @claude" cannot enqueue the same ask twice.
        UNIQUE (comment_id, target_id)
      );

      CREATE INDEX idx_mentions_open ON task_mentions (target_id, status, created_at);
      CREATE INDEX idx_mentions_task ON task_mentions (task_id, created_at);
    `,
  },
  {
    version: 3,
    name: "inbox_sync",
    sql: /* sql */ `
      -- Natural key of whatever a task was imported from ("outlook:AAMk...").
      -- The partial unique index is what makes a sync re-runnable: importing the
      -- same mail twice is a conflict, not a duplicate card.
      ALTER TABLE tasks ADD COLUMN source_ref TEXT;
      CREATE UNIQUE INDEX idx_tasks_source_ref ON tasks (board_id, source_ref)
        WHERE source_ref IS NOT NULL;

      -- The watermark, one row per board per source. Advanced only when a run
      -- actually succeeds, so a failed sync re-reads its window instead of
      -- skipping it.
      CREATE TABLE board_sync_state (
        board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        source         TEXT NOT NULL CHECK (source IN ('outlook','teams')),
        synced_through TEXT,
        last_run_at    TEXT,
        last_status    TEXT CHECK (last_status IN ('ok','failed')),
        last_detail    TEXT,
        imported       INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (board_id, source)
      );

      -- Queued work, because the process that can reach Microsoft Graph is not
      -- the process serving the button. The web app enqueues; an agent run
      -- claims, imports and completes.
      CREATE TABLE sync_runs (
        id           TEXT PRIMARY KEY,
        board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        -- JSON: [{ "source": "outlook", "since": "<iso>" }, ...]
        scope        TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('pending','running','ok','failed','cancelled')),
        requested_by TEXT NOT NULL REFERENCES users(id),
        actor_source TEXT NOT NULL CHECK (actor_source IN ('web','mcp','system')),
        -- Earliest point scanned, and the cutoff that becomes the new watermark.
        since        TEXT NOT NULL,
        cutoff       TEXT NOT NULL,
        imported     INTEGER NOT NULL DEFAULT 0,
        detail       TEXT,
        started_at   TEXT,
        finished_at  TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE INDEX idx_sync_runs_board  ON sync_runs (board_id, id DESC);
      CREATE INDEX idx_sync_runs_status ON sync_runs (status, created_at);
    `,
  },
  {
    version: 4,
    name: "task_responses",
    sql: /* sql */ `
      -- Every synced card exists because somebody mailed or messaged the user, so
      -- the card is only half the work: the other half is the reply they owe. A
      -- response is a DRAFT and nothing in this system ever sends one — 'sent' is
      -- the human recording that they sent it themselves.
      --
      -- Two axes make one card's replies distinguishable:
      --   channel  email needs a subject line, a Teams message must not have one;
      --   stage    'acknowledge' is the reply to send now, 'completion' the one to
      --            send once the work is actually done.
      CREATE TABLE task_responses (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        channel        TEXT NOT NULL CHECK (channel IN ('email','chat')),
        stage          TEXT NOT NULL CHECK (stage IN ('acknowledge','completion')),
        status         TEXT NOT NULL CHECK (status IN ('draft','approved','sent','discarded')),
        -- Who it goes to. recipient_ref is the machine-usable half (an address or
        -- a chat id); recipient_name is what the UI shows.
        recipient_name TEXT NOT NULL,
        recipient_ref  TEXT,
        -- JSON array of additional addresses. Email only.
        cc             TEXT,
        -- Email only; NULL for chat, enforced in core so both transports agree.
        subject        TEXT,
        body           TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('outlook','teams','manual')),
        -- The message being replied to, e.g. "outlook:AAMk...". Provenance only:
        -- uniqueness is the slot index below, not this.
        source_ref     TEXT,
        created_by     TEXT NOT NULL REFERENCES users(id),
        actor_source   TEXT NOT NULL CHECK (actor_source IN ('web','mcp','system')),
        -- Bumped by every rewrite, so the UI can tell a draft changed under it.
        revision       INTEGER NOT NULL DEFAULT 1,
        sent_at        TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      -- One live draft per person per stage, so re-running a draft pass over the
      -- same card is a conflict naming the existing draft rather than a second
      -- copy of the same reply — the same rule tasks.source_ref gives imports.
      -- Discarded drafts drop out of the index so a slot can be redrafted.
      CREATE UNIQUE INDEX idx_responses_slot
        ON task_responses (task_id, channel, recipient_ref, stage)
        WHERE recipient_ref IS NOT NULL AND status != 'discarded';

      CREATE INDEX idx_responses_task  ON task_responses (task_id, stage, created_at);
      CREATE INDEX idx_responses_board ON task_responses (board_id, status);

      -- The queue and the chat transcript are the same table, because they are the
      -- same thing: one turn is "the human asked for a change" plus "what Claude
      -- did about it" plus "what the draft became". A pending turn is work; a
      -- finished one is a message in the thread the user reads.
      --
      -- The Express process cannot ask Claude anything — it has no model access —
      -- so a revision is queued here exactly as a sync is, and an agent run picks
      -- it up. kind = 'edit' is the exception: a manual edit is inserted already
      -- done, so the thread reads as one history rather than two.
      CREATE TABLE response_turns (
        id             TEXT PRIMARY KEY,
        -- NULL only for a card-level 'draft' request, which has no draft yet.
        response_id    TEXT REFERENCES task_responses(id) ON DELETE CASCADE,
        task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        kind           TEXT NOT NULL CHECK (kind IN ('draft','revise','edit')),
        -- What was asked for, in the user's words. For 'edit', what they changed.
        instruction    TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','claimed','done','failed','cancelled')),
        requested_by   TEXT NOT NULL REFERENCES users(id),
        actor_source   TEXT NOT NULL CHECK (actor_source IN ('web','mcp','system')),
        -- Spawns already made for this turn, so a watcher can give up and say so.
        attempts       INTEGER NOT NULL DEFAULT 0,
        -- Claude's side of the exchange, or the reason it failed.
        note           TEXT,
        -- What the draft became. Kept per turn so the thread is auditable after
        -- the next rewrite has overwritten the draft itself.
        result_subject TEXT,
        result_body    TEXT,
        claimed_at     TEXT,
        finished_at    TEXT,
        created_at     TEXT NOT NULL,
        -- A draft request produces responses, so it cannot name one; a revise or
        -- an edit acts on exactly one.
        CHECK ((kind = 'draft') = (response_id IS NULL))
      );

      CREATE INDEX idx_turns_queue    ON response_turns (status, created_at);
      CREATE INDEX idx_turns_response ON response_turns (response_id, created_at);
      CREATE INDEX idx_turns_task     ON response_turns (task_id, created_at);
    `,
  },
  {
    version: 5,
    name: "board_intake",
    sql: /* sql */ `
      -- A chat on the board for turning raw material into cards: a pasted CSV, a
      -- meeting note, an email thread, a screenshot of somebody's plan.
      --
      -- Same shape as response_turns, for the same reason: the queue and the
      -- transcript are one table. A 'pending' row is work waiting for an agent
      -- run; a finished one is a message in the conversation the user scrolls.
      -- The Express process has no model access, so pasting is all it can do.
      CREATE TABLE intake_messages (
        id            TEXT PRIMARY KEY,
        board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        -- What the user typed alongside what they pasted. May be blank when the
        -- pasted material speaks for itself.
        instruction   TEXT NOT NULL,
        -- Pasted text, verbatim. Newlines and column alignment are the content
        -- when the content is a CSV, so nothing is normalised out of it.
        content       TEXT,
        status        TEXT NOT NULL CHECK (status IN ('pending','claimed','done','failed','cancelled')),
        requested_by  TEXT NOT NULL REFERENCES users(id),
        actor_source  TEXT NOT NULL CHECK (actor_source IN ('web','mcp','system')),
        -- Spawns already made, so a watcher can give up and say so.
        attempts      INTEGER NOT NULL DEFAULT 0,
        -- Claude's reply in the chat, or the reason nothing happened.
        note          TEXT,
        -- JSON array of task ids created, so the reply can link the cards it made
        -- rather than describing them and leaving the user to go and find them.
        created_tasks TEXT,
        claimed_at    TEXT,
        finished_at   TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX idx_intake_board ON intake_messages (board_id, created_at);
      CREATE INDEX idx_intake_queue ON intake_messages (status, created_at);

      -- One pasted or dropped file. Text-bearing kinds are decoded once, here, at
      -- upload: the extracted text travels in the prompt, so a pasted CSV needs no
      -- file access from the run at all. Only an image or a PDF leaves the run
      -- something it has to open, and that is what decides its tool allowlist.
      CREATE TABLE intake_attachments (
        id          TEXT PRIMARY KEY,
        message_id  TEXT NOT NULL REFERENCES intake_messages(id) ON DELETE CASCADE,
        board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        filename    TEXT NOT NULL,
        mime        TEXT NOT NULL,
        -- 'text' is inlined into the prompt; 'image' and 'pdf' are read from disk.
        kind        TEXT NOT NULL CHECK (kind IN ('text','image','pdf')),
        bytes       INTEGER NOT NULL,
        -- Relative to INTAKE_DIR, never absolute: an absolute path baked into a row
        -- breaks the moment the repo moves.
        path        TEXT NOT NULL,
        -- Decoded contents for kind='text'. NULL for the binary kinds.
        text        TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX idx_intake_files ON intake_attachments (message_id, created_at);
    `,
  },
  {
    version: 6,
    name: "projects",
    sql: /* sql */ `
      -- A project is a directory on the user's machine. Attaching one to a card,
      -- or to a whole board, is what lets an @claude request be carried out
      -- *inside that codebase*: the run is spawned with the directory as its
      -- working directory, so it inherits that repo's CLAUDE.md and its files and
      -- sees nothing else — enough context to fix the bug named on the card,
      -- rather than the whole machine.
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        -- Stable handle, so a conversation and a tool argument can both say
        -- "nexus_web" rather than an opaque id.
        slug        TEXT NOT NULL,
        -- Absolute, always. A relative path resolves against whichever process
        -- happens to read the row, which is the one way this can silently point
        -- somewhere other than the directory the user chose.
        path        TEXT NOT NULL,
        -- What the codebase is, in the user's words. It travels in the prompt, so
        -- it is the first thing a delegated run knows about where it has landed.
        description TEXT,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_projects_slug ON projects (slug);
      -- One directory is one project. Registering the same path twice would make
      -- "which project is this card in" ambiguous for nothing in return.
      CREATE UNIQUE INDEX idx_projects_path ON projects (path);

      -- The board's default and the card's override, kept as two nullable columns
      -- rather than stamped onto each card at creation: pointing a board at a
      -- different checkout then moves every card that never overrode it, which is
      -- what a default is for.
      ALTER TABLE boards ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
      ALTER TABLE tasks  ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

      CREATE INDEX idx_tasks_project ON tasks (project_id);
    `,
  },
];

/** Assignees exist before any board does, so both transports can reference them. */
export const SEED_USERS = [
  { id: "me", displayName: "Me", kind: "human" as const },
  { id: "claude", displayName: "Claude", kind: "agent" as const },
];

/** Applied to every new board; users can add, rename or delete columns after. */
export const DEFAULT_COLUMNS = [
  { key: "todo", name: "To do", kind: "backlog" as const },
  { key: "doing", name: "Doing", kind: "active" as const },
  { key: "blocked", name: "Blocked", kind: "blocked" as const },
  { key: "needs_review", name: "Needs review", kind: "review" as const },
  { key: "done", name: "Done", kind: "done" as const },
];
