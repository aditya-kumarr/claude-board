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
      `INSERT INTO projects (id, name, slug, path, description, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
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
    const known = listProjects({ includeArchived: true }).map((project) => project.slug);
    throw notFound(
      `project '${reference}'${known.length ? ` (known projects: ${known.join(", ")})` : " (no projects registered yet)"}`,
    );
  }
  return toProject(row);
}

export interface ListProjectsOptions {
  includeArchived?: boolean;
}

export function listProjects(options: ListProjectsOptions = {}): Project[] {
  return getDb()
    .query<ProjectRow, []>(
      `SELECT * FROM projects ${options.includeArchived ? "" : "WHERE archived = 0"} ORDER BY lower(name) ASC`,
    )
    .all()
    .map(toProject);
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  description?: string | null;
  archived?: boolean;
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
  if (input.archived !== undefined) {
    sets.push("archived = ?");
    params.push(input.archived ? 1 : 0);
    changed.archived = input.archived;
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

/**
 * Unregisters a directory. Nothing on disk is touched, and no card is deleted:
 * `ON DELETE SET NULL` detaches every board and task pointing here, which the
 * count in the result names rather than leaving the user to discover.
 */
export function deleteProject(projectId: string, actor: ActorContext): {
  id: string;
  detachedBoards: number;
  detachedTasks: number;
} {
  const project = getProject(projectId);
  const db = getDb();
  const detachedBoards =
    db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM boards WHERE project_id = ?").get(projectId)
      ?.count ?? 0;
  const detachedTasks =
    db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").get(projectId)
      ?.count ?? 0;

  write((inner) => {
    record(inner, actor, "project.deleted", {}, {
      projectId,
      name: project.name,
      path: project.path,
      detachedBoards,
      detachedTasks,
    });
    inner.run("DELETE FROM projects WHERE id = ?", [projectId]);
  });

  log.warn("project unregistered", {
    projectId,
    name: project.name,
    detachedBoards,
    detachedTasks,
    actor: actor.actorId,
  });
  return { id: projectId, detachedBoards, detachedTasks };
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
 * An archived project still resolves: archiving hides a directory from the
 * pickers, it does not orphan the cards already pointing at it.
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
