import { useEffect, useState } from "react";
import { Archive, FolderGit2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Separator } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import type { Project } from "@/lib/types";

/**
 * Registering the directories work can be delegated into.
 *
 * Worth being blunt in the copy here rather than only in the code: a card that
 * resolves to a project is a card an unattended `@claude` run will open, edit and
 * run commands inside. So this dialog is the consent step — the path is typed
 * once, deliberately, and never inferred from something someone wrote in a
 * comment.
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

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setAdding(false);
    setError(null);
  }, [open]);

  const active = projects.filter((project) => !project.archived);
  const archived = projects.filter((project) => project.archived);

  const remove = async (project: Project) => {
    if (
      !window.confirm(
        `Unregister "${project.name}"?\n\nNothing in ${project.path} is touched and no cards are deleted — ` +
          `any board or card pointing at it simply stops having a project.`,
      )
    ) {
      return;
    }
    try {
      const result = await api.deleteProject(project.id);
      onChanged();
      setError(
        result.detachedBoards + result.detachedTasks > 0
          ? `Unregistered. ${result.detachedBoards} board(s) and ${result.detachedTasks} card(s) now have no project.`
          : null,
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not unregister that project");
    }
  };

  const setArchived = async (project: Project, archivedNext: boolean) => {
    try {
      await api.updateProject(project.id, { archived: archivedNext });
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not change that project");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
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
            <span className="flex-1">{error}</span>
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

          {[...active, ...archived].map((project) =>
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
                    {project.archived ? <Badge variant="outline">archived</Badge> : null}
                  </div>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{project.path}</p>
                  {project.description ? (
                    <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{project.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Hint label="Edit">
                    <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(project.id)} aria-label="Edit project">
                      <Pencil />
                    </Button>
                  </Hint>
                  <Hint label={project.archived ? "Restore" : "Archive — hides it from the pickers"}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void setArchived(project, !project.archived)}
                      aria-label={project.archived ? "Restore project" : "Archive project"}
                    >
                      <Archive />
                    </Button>
                  </Hint>
                  <Hint label="Unregister">
                    <Button variant="ghost" size="icon-sm" onClick={() => void remove(project)} aria-label="Unregister project">
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
