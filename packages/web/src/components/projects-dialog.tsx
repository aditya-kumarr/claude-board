import { useEffect, useState } from "react";
import { AlertTriangle, FolderGit2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Separator } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import type { Project, ProjectUsage } from "@/lib/types";

/**
 * Registering the directories work can be delegated into.
 *
 * Worth being blunt in the copy here rather than only in the code: a card that
 * resolves to a project is a card an unattended `@claude` run will open, edit and
 * run commands inside. So this dialog is the consent step — the path is typed
 * once, deliberately, and never inferred from something someone wrote in a
 * comment.
 *
 * There is no archive here, unlike boards. Archiving a project hid it from the
 * pickers while it still held its path, so the one thing a user does after
 * retiring a directory — register it again — came back as "already registered"
 * naming a row they could no longer see. Delete is the only exit, and because it
 * takes the boards and cards with it, it goes through `DeleteProjectDialog`.
 */
export function ProjectsDialog({
  projects,
  open,
  onOpenChange,
  onChanged,
}: {
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setAdding(false);
    setError(null);
    setDeleting(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `[&>*]:min-w-0` for the reason spelled out in DeleteProjectDialog: this
          content is a grid, and the paths and board names here are exactly the
          unbreakable strings that would otherwise stretch it. */}
      <DialogContent className="max-w-2xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
          <DialogDescription>
            Directories on the machine running this board. Point a board or a single card at one, and an{" "}
            <span className="font-mono text-[11px]">@claude</span> request on that card is carried out{" "}
            <span className="font-medium text-foreground">inside that directory</span> — with the codebase's own
            context, and with permission to change it.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-2.5 text-xs">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              <X className="size-3.5 opacity-60" />
            </button>
          </p>
        ) : null}

        <div className="space-y-2">
          {projects.length === 0 && !adding ? (
            <EmptyState
              icon={<FolderGit2 />}
              title="No projects yet"
              hint="Register a directory and cards can be worked on inside it."
            />
          ) : null}

          {projects.map((project) =>
            editingId === project.id ? (
              <ProjectForm
                key={project.id}
                project={project}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  onChanged();
                }}
              />
            ) : (
              <div
                key={project.id}
                className="flex items-start gap-3 rounded-md border border-border/70 bg-surface/40 p-2.5"
              >
                <FolderGit2 className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-[13px] font-medium">{project.name}</p>
                    <span className="font-mono text-[10px] text-muted-foreground">{project.slug}</span>
                  </div>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{project.path}</p>
                  {project.description ? (
                    <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{project.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Hint label="Edit — including pointing it at a directory that moved">
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(project.id)} aria-label="Edit project">
                      <Pencil />
                    </Button>
                  </Hint>
                  {/* No archive: see the note at the top of the file. Delete is the
                      only exit, and it takes this project's boards and cards with
                      it, so it asks first. */}
                  <Hint label="Delete — with the boards and cards that use it">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDeleting(project)}
                      aria-label={`Delete ${project.name}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </Hint>
                </div>
              </div>
            ),
          )}
        </div>

        <Separator />

        {adding ? (
          <ProjectForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              onChanged();
            }}
          />
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}>
            <Plus /> Add a project
          </Button>
        )}

        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(project, result) => {
            setDeleting(null);
            onChanged();
            setError(
              result.deletedBoards + result.deletedTasks > 0
                ? `Deleted "${project.name}", along with ${result.deletedBoards} board(s) and ${result.deletedTasks} card(s). ` +
                    `Nothing in ${project.path} was touched, and that directory can be registered again.`
                : `Deleted "${project.name}". Nothing in ${project.path} was touched.`,
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one way to remove a project, and therefore the place the cascade is spelled
 * out.
 *
 * The usage is fetched rather than derived from the boards already in memory,
 * because a card can override its board's project and the sidebar's list does not
 * know which — and because the same query is what the API will enforce against.
 * Until it arrives there is no button to press: consenting to "and everything
 * that uses it" without being told what that is is the failure this dialog
 * exists to prevent. The checkbox is required only when something is actually at
 * stake, so retiring an unused directory stays one click.
 */
function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project | null;
  onClose: () => void;
  onDeleted: (project: Project, result: { deletedBoards: number; deletedTasks: number }) => void;
}) {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsage(null);
    setAcknowledged(false);
    setError(null);
    if (!project) return;
    let cancelled = false;
    api
      .projectUsage(project.id)
      .then((next) => !cancelled && setUsage(next))
      .catch((cause) => !cancelled && setError(cause instanceof ApiError ? cause.message : "Could not read what uses this project"));
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const inUse = usage !== null && (usage.boards.length > 0 || usage.totalTasks > 0);
  const confirm = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteProject(project.id, { confirmCascade: inUse });
      onDeleted(project, result);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not delete that project");
    } finally {
      setBusy(false);
    }
  };

  return (
    // `[&>*]:min-w-0` because DialogContent is a grid, and a grid item's implicit
    // `min-width: auto` lets one unbreakable string — a board name, an imported
    // card's subject line, the path — widen the track past `max-w-lg` and give the
    // whole dialog a horizontal scrollbar. Every child below wraps or truncates,
    // so letting them shrink is the fix rather than a clip.
    <Dialog open={project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <span className="min-w-0 break-words">Delete {project?.name ?? "this project"}?</span>
          </DialogTitle>
          <DialogDescription>
            A project cannot be archived, so this is the only way to remove one — and it takes the work that pointed
            at it. Nothing inside{" "}
            <span className="break-all font-mono text-[11px] text-foreground">{project?.path}</span> is touched: only
            this app's boards and cards go.
          </DialogDescription>
        </DialogHeader>

        {usage === null ? (
          <p className="text-xs text-muted-foreground">Checking what uses it…</p>
        ) : inUse ? (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/8 p-3 text-xs scrollbar-slim">
            {usage.boards.length > 0 ? (
              <div className="space-y-1">
                <p className="font-medium">
                  {usage.boards.length} board{usage.boards.length > 1 ? "s" : ""} will be deleted, with everything on
                  them:
                </p>
                <ul className="space-y-0.5">
                  {usage.boards.map((board) => (
                    <li key={board.id} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{board.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {board.taskCount} card{board.taskCount === 1 ? "" : "s"}
                      </span>
                      {board.archived ? <Badge variant="outline">archived</Badge> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {usage.tasks.length > 0 ? (
              <div className="space-y-1">
                <p className="font-medium">
                  {usage.tasks.length} card{usage.tasks.length > 1 ? "s" : ""} on other boards name this project
                  themselves and will be deleted too:
                </p>
                <ul className="space-y-0.5">
                  {usage.tasks.slice(0, 6).map((task) => (
                    <li key={task.id} className="min-w-0 truncate">
                      {task.title} <span className="text-muted-foreground">· {task.boardName}</span>
                    </li>
                  ))}
                  {usage.tasks.length > 6 ? (
                    <li className="text-muted-foreground">and {usage.tasks.length - 6} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            <p className="text-muted-foreground">
              {usage.totalTasks} card{usage.totalTasks === 1 ? "" : "s"} in total. This cannot be undone. To keep the
              work and only change where it runs, close this and edit the project's directory instead.
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-border bg-muted/50 p-2.5 text-xs">
            Nothing points at this project, so no board or card is affected.
          </p>
        )}

        {inUse ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--destructive)]"
            />
            <span className="min-w-0">
              I understand that the {usage.boards.length} board(s) and {usage.totalTasks} card(s) above are deleted
              along with this project.
            </span>
          </label>
        ) : null}

        {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            loading={busy}
            disabled={usage === null || (inUse && !acknowledged)}
          >
            <Trash2 /> {inUse ? "Delete project and its work" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add and edit are one form: the fields, the validation and the failure modes are
 * identical, and the only difference is which request it sends.
 */
function ProjectForm({
  project,
  onCancel,
  onSaved,
}: {
  project?: Project;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !path.trim()) {
      setError("A project needs a name and a directory");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), path: path.trim(), description: description.trim() || null };
      if (project) await api.updateProject(project.id, payload);
      else await api.createProject(payload);
      onSaved();
    } catch (cause) {
      // The path is checked on the server, because that is the machine the
      // directory has to exist on — so "no such directory" arrives as a 400 and
      // belongs here, next to the field the user has to fix.
      setError(cause instanceof ApiError ? cause.message : "Could not save that project");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-ring/35 bg-surface/60 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nexus web"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </div>
        <div className="space-y-1.5">
          <Label hint="on the board's machine">Directory</Label>
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="~/Code/nexus-web"
            className="font-mono text-[12px]"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label hint="optional, but read by every delegated run">What is it?</Label>
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Next.js front end for the facilities portal. Run checks with `pnpm test`."
          rows={2}
        />
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} loading={saving}>
          {project ? "Save" : "Register"}
        </Button>
      </div>
    </div>
  );
}
