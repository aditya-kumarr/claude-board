import type { SQLQueryBindings } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getDb, write } from "../db/index.ts";
import {
  toProject,
  toResolvedProject,
  type ProjectContextRow,
  type ProjectRow,
} from "../db/rows.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId, slugify } from "../lib/ids.ts";
import { createLogger } from "../lib/logger.ts";
import type { Project, ResolvedProject } from "../types.ts";
import { record } from "./activity.ts";
import type { ActorContext } from "./context.ts";

const log = createLogger("projects");

/**
 * A project is a directory on this machine, registered so that work on a card can
 * be carried out *inside* it.
 *
 * This service is a deliberate leaf: it imports neither `boards` nor `tasks`, and
 * reads the two columns it needs with its own query, for the same reason
 * `sync.ts` does — `getBoardDetail` embeds this service's own summary, so
 * importing it back would close a cycle.
 *
 * The rule the rest of the system leans on is one line: a card's project is its
 * own if it names one, otherwise its board's. Nothing is copied at creation time,
 * so re-pointing a board at a different checkout moves every card that never
 * overrode it.
 *
 * A project cannot be archived, and that is deliberate: the two states a *board*
 * has -- closed but readable, and gone -- are not both real for a directory. An
 * archived project was hidden from the pickers while still holding its path in
 * the UNIQUE index, so the natural next act (register that directory again) came
 * back as "already registered as ..." naming a row the user could no longer see.
 * There is one way out instead, `deleteProject`, and it takes the work with it.
 */

/** `~/Code/app` is what a person types; a row must hold what a process can open. */
function expandHome(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * Normalises and *checks* a directory at the moment it is registered.
 *
 * Rejecting a bad path here rather than at delegation time is the difference
 * between a typo the user fixes in the dialog they are already looking at and a
 * queued request that dies half an hour later in a watcher's log.
 */
export function normaliseProjectPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw badRequest("path is required");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw badRequest(
      `path must be absolute (or start with ~), because it is opened by processes started from other directories`,
      { path: raw },
    );
  }
  // Trailing slashes and `..` segments normalised away, so the UNIQUE index sees
  // two spellings of one directory as one directory.
  const path = resolve(expanded);
  if (!existsSync(path)) throw badRequest(`there is no directory at ${path}`, { path });
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    // A path this process cannot stat — usually a parent directory it may not
    // read — is a 400 the user can act on, not a 500 from deep inside a query.
    throw badRequest(`${path} exists but cannot be read by the board process`, {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (!stats.isDirectory()) throw badRequest(`${path} is a file, not a directory`, { path });
  return path;
}

/** Never throws: it is called from renderers whose job is only to *say* whether the path is live. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the directory is still there. Checked at read time, never cached. */
export const projectPathExists = (path: string): boolean => isDirectory(path);

function requireProjectName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("name is required");
  if (value.trim().length > 120) throw badRequest("name must be 120 characters or fewer");
  return value.trim();
}

/** `nexus_web`, `nexus_web_2`, … — a handle stays usable when two repos share a name. */
function uniqueSlug(base: string, excludeId?: string): string {
  const taken = new Set(
    getDb()
      .query<{ slug: string; id: string }, []>("SELECT slug, id FROM projects")
      .all()
      .filter((row) => row.id !== excludeId)
      .map((row) => row.slug),
  );
  const root = slugify(base);
  if (!taken.has(root)) return root;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${root}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return newId("prj");
}

export interface CreateProjectInput {
  name: string;
  /** Absolute path, or one starting with `~`. Must exist and be a directory. */
  path: string;
  description?: string | null;
}

export function createProject(input: CreateProjectInput, actor: ActorContext): Project {
  const name = requireProjectName(input.name);
  const path = normaliseProjectPath(input.path);

  // Checked up front so the caller gets the existing project's id, which a bare
  // UNIQUE violation would not tell them — the same bargain `tasks.source_ref`
  // makes for an import.
  const existing = getDb()
    .query<ProjectRow, [string]>("SELECT * FROM projects WHERE path = ?")
    .get(path);
  if (existing) {
    throw conflict(`${path} is already registered as "${existing.name}"`, {
      path,
      existingProjectId: existing.id,
      existingName: existing.name,
    });
  }

  const id = newId("prj");
  const slug = uniqueSlug(name);
  const now = new Date().toISOString();
  write((db) => {
    db.run(
      `INSERT INTO projects (id, name, slug, path, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, slug, path, input.description?.trim() || null, now, now],
    );
    record(db, actor, "project.created", {}, { projectId: id, name, slug, path });
  });

  log.info("project registered", { projectId: id, name, slug, path, actor: actor.actorId, source: actor.source });
  return getProject(id);
}

export function getProject(projectId: string): Project {
  const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!row) throw notFound("project", projectId);
  return toProject(row);
}

/** The project a nullable column points at, or `null`. Never throws on a stale id. */
export function findProject(projectId: string | null): Project | null {
  if (!projectId) return null;
  const row = getDb().query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(projectId);
  return row ? toProject(row) : null;
}

/**
 * Accepts whatever a conversation or a form produces: an id, the slug, the
 * display name, or the path itself — the last one because the user pasting the
 * directory they mean is the most natural thing they can do.
 */
export function requireProject(reference: string): Project {
  const raw = reference.trim();
  if (raw === "") throw badRequest("project reference cannot be empty");
  const key = raw.toLowerCase();
  const db = getDb();

  const row =
    db
      .query<ProjectRow, [string, string]>(
        "SELECT * FROM projects WHERE lower(id) = ? OR lower(slug) = ? LIMIT 1",
      )
      .get(key, key) ??
    db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE lower(name) = ? LIMIT 1").get(key) ??
    // Path last, and expanded first, so "~/Code/app" finds the row holding the
    // absolute form of the same directory.
    db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE path = ? LIMIT 1").get(resolve(expandHome(raw)));

  if (!row) {
    const known = listProjects().map((project) => project.slug);
    throw notFound(
      `project '${reference}'${known.length ? ` (known projects: ${known.join(", ")})` : " (no projects registered yet)"}`,
    );
  }
  return toProject(row);
}

export function listProjects(): Project[] {
  return getDb()
    .query<ProjectRow, []>("SELECT * FROM projects ORDER BY lower(name) ASC")
    .all()
    .map(toProject);
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  description?: string | null;
}

export function updateProject(projectId: string, input: UpdateProjectInput, actor: ActorContext): Project {
  const existing = getProject(projectId);
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const changed: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = requireProjectName(input.name);
    sets.push("name = ?");
    params.push(name);
    changed.name = name;
    // The slug follows the name, because a handle that no longer resembles the
    // project is a handle nobody will type. Uniqueness is re-checked either way.
    const slug = uniqueSlug(name, projectId);
    sets.push("slug = ?");
    params.push(slug);
    changed.slug = slug;
  }
  if (input.path !== undefined) {
    const path = normaliseProjectPath(input.path);
    if (path !== existing.path) {
      const clash = getDb()
        .query<{ id: string; name: string }, [string, string]>(
          "SELECT id, name FROM projects WHERE path = ? AND id != ?",
        )
        .get(path, projectId);
      if (clash) {
        throw conflict(`${path} is already registered as "${clash.name}"`, {
          path,
          existingProjectId: clash.id,
        });
      }
    }
    sets.push("path = ?");
    params.push(path);
    changed.path = path;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    sets.push("description = ?");
    params.push(description);
    changed.description = description;
  }
  if (sets.length === 0) return existing;

  write((db) => {
    db.run(`UPDATE projects SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
      ...params,
      new Date().toISOString(),
      projectId,
    ]);
    record(db, actor, "project.updated", {}, { projectId, ...changed });
  });

  log.info("project updated", { projectId, changed, actor: actor.actorId, source: actor.source });
  return getProject(projectId);
}

/** What a project delete would take with it. Read before the act, shown to the user. */
export interface ProjectUsage {
  projectId: string;
  /** Boards whose default project is this one. Deleting the project deletes them. */
  boards: { id: string; name: string; taskCount: number; archived: boolean }[];
  /**
   * Cards that name this project *themselves* while living on a board that does
   * not — the ones a "delete the boards" summary would not account for.
   */
  tasks: { id: string; title: string; boardId: string; boardName: string }[];
  /** Cards on the doomed boards plus the overriding cards above, counted once each. */
  totalTasks: number;
}

/**
 * Everything that would go if this project were deleted.
 *
 * Its own queries again, for the reason at the top of the file — and it is a
 * separate call rather than a field on `Project` because it is only ever wanted
 * at the moment somebody reaches for the delete button, and it costs three
 * counts.
 */
export function projectUsage(projectId: string): ProjectUsage {
  const project = getProject(projectId);
  const db = getDb();

  const boards = db
    .query<{ id: string; name: string; archived: number; task_count: number }, [string]>(
      `SELECT b.id, b.name, b.archived,
              (SELECT COUNT(*) FROM tasks t WHERE t.board_id = b.id) AS task_count
         FROM boards b
        WHERE b.project_id = ?
        ORDER BY lower(b.name) ASC`,
    )
    .all(project.id);

  // `b.project_id IS NOT ?` rather than a plain inequality: a card overriding to
  // this project on a board with *no* project must still be listed, and NULL
  // compares false to everything under `!=`.
  const tasks = db
    .query<{ id: string; title: string; board_id: string; board_name: string }, [string, string]>(
      `SELECT t.id, t.title, t.board_id, b.name AS board_name
         FROM tasks t
         JOIN boards b ON b.id = t.board_id
        WHERE t.project_id = ? AND b.project_id IS NOT ?
        ORDER BY b.name ASC, t.created_at ASC`,
    )
    .all(project.id, project.id);

  const boardTasks = boards.reduce((sum, board) => sum + board.task_count, 0);
  return {
    projectId: project.id,
    boards: boards.map((board) => ({
      id: board.id,
      name: board.name,
      taskCount: board.task_count,
      archived: board.archived === 1,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      boardId: task.board_id,
      boardName: task.board_name,
    })),
    totalTasks: boardTasks + tasks.length,
  };
}

export interface DeleteProjectOptions {
  /**
   * Consent to the cascade. Required — and only required — when something
   * actually points at the project, so unregistering an unused directory stays a
   * one-liner while deleting a live one is an act the caller had to mean.
   */
  confirmCascade?: boolean;
}

/**
 * Deletes a project **and the work that pointed at it**: every board whose
 * default project is this one (with its columns, cards and comments, via
 * `ON DELETE CASCADE`) and every card that named this project itself.
 *
 * The cascade replaces an earlier `ON DELETE SET NULL` detach, and the reason is
 * that a detached board was worse than either honest outcome — the cards stayed,
 * silently no longer runnable inside any directory, and an `@claude` on one had
 * nowhere to go. Since a project cannot be archived any more, delete is the only
 * exit, so it says plainly what it takes and refuses to guess: with dependents
 * and no `confirmCascade`, it is a `conflict` carrying the counts, which is what
 * the UI puts behind its checkbox and what a tool call gets told to pass.
 *
 * Nothing on disk is touched. The directory outlives the row, which is why
 * registering it again afterwards has to work.
 */
export function deleteProject(
  projectId: string,
  actor: ActorContext,
  options: DeleteProjectOptions = {},
): {
  id: string;
  deletedBoards: number;
  deletedTasks: number;
} {
  const project = getProject(projectId);
  const usage = projectUsage(project.id);
  const deletedBoards = usage.boards.length;
  const deletedTasks = usage.totalTasks;

  if ((deletedBoards > 0 || deletedTasks > 0) && options.confirmCascade !== true) {
    throw conflict(
      `"${project.name}" is in use: deleting it also deletes ${deletedBoards} board(s) and ${deletedTasks} card(s). ` +
        `Pass confirmCascade to go ahead.`,
      {
        projectId: project.id,
        name: project.name,
        path: project.path,
        boards: usage.boards,
        tasks: usage.tasks,
        deletedBoards,
        deletedTasks,
        requiresConfirmation: "confirmCascade",
      },
    );
  }

  write((db) => {
    record(db, actor, "project.deleted", {}, {
      projectId,
      name: project.name,
      path: project.path,
      deletedBoards,
      deletedTasks,
      boards: usage.boards.map((board) => board.name),
    });
    // Boards first: their cards, columns and comments go with them, so the
    // second statement is left with exactly the overriding cards on other boards.
    db.run("DELETE FROM boards WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM tasks WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM projects WHERE id = ?", [projectId]);
  });

  log.warn("project deleted", {
    projectId,
    name: project.name,
    deletedBoards,
    deletedTasks,
    actor: actor.actorId,
    source: actor.source,
  });
  return { id: projectId, deletedBoards, deletedTasks };
}

/* ------------------------------------------------------- resolution for a card */

/**
 * Joins for a query that already has `tasks t` and `boards b` in scope.
 *
 * Every field is taken from the *same* side of the CASE rather than with an
 * `IFNULL` per column: a card-level project with no description would otherwise
 * borrow its board's project's description, which is exactly the kind of quiet
 * mix that makes a delegated run act on the wrong repo's notes.
 */
export const PROJECT_CONTEXT_JOIN = /* sql */ `
  LEFT JOIN projects tp ON tp.id = t.project_id
  LEFT JOIN projects bp ON bp.id = b.project_id
`;

export const PROJECT_CONTEXT_COLUMNS = /* sql */ `
  CASE WHEN tp.id IS NOT NULL THEN tp.id          ELSE bp.id          END AS project_id,
  CASE WHEN tp.id IS NOT NULL THEN tp.name        ELSE bp.name        END AS project_name,
  CASE WHEN tp.id IS NOT NULL THEN tp.slug        ELSE bp.slug        END AS project_slug,
  CASE WHEN tp.id IS NOT NULL THEN tp.path        ELSE bp.path        END AS project_path,
  CASE WHEN tp.id IS NOT NULL THEN tp.description ELSE bp.description END AS project_description,
  CASE WHEN tp.id IS NOT NULL THEN 'task' WHEN bp.id IS NOT NULL THEN 'board' END AS project_via
`;

/**
 * The directory work on this card should happen in — the card's own project if it
 * names one, otherwise its board's, and `null` when neither does.
 *
 * Never a dangling id: deleting a project deletes the boards and cards that
 * pointed at it, so a row that resolves is a row that exists.
 */
export function resolveProjectForTask(taskId: string): ResolvedProject | null {
  const row = getDb()
    .query<ProjectContextRow, [string]>(
      `SELECT ${PROJECT_CONTEXT_COLUMNS}
         FROM tasks t
         JOIN boards b ON b.id = t.board_id
         ${PROJECT_CONTEXT_JOIN}
        WHERE t.id = ?`,
    )
    .get(taskId);
  if (!row) throw notFound("task", taskId);
  return toResolvedProject(row);
}
