import { useEffect, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ProjectSelect, shortPath } from "@/components/project-select";
import { api, ApiError } from "@/lib/api";
import type { BoardDetail, Project } from "@/lib/types";

/**
 * Points a whole board at a directory.
 *
 * Board-level rather than per-card is the common case by a distance: a board is
 * usually about one codebase, and setting it once means every card on it —
 * including the ones a sync or a paste creates later — is already actionable.
 */
export function BoardProjectDialog({
  board,
  projects,
  open,
  onOpenChange,
  onSaved,
  onManageProjects,
}: {
  board: BoardDetail | null;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onManageProjects: () => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !board) return;
    setProjectId(board.board.projectId);
    setError(null);
  }, [open, board?.board.id, board?.board.projectId]);

  const chosen = projects.find((project) => project.id === projectId) ?? null;
  const overrides = board?.tasks.filter((task) => task.projectId !== null && task.projectId !== projectId).length ?? 0;

  const submit = async () => {
    if (!board) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateBoard(board.board.id, { project: projectId });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not set the project");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open && board !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project for this board</DialogTitle>
          <DialogDescription>
            The directory work on {board ? `"${board.board.name}"` : "this board"} happens in. Every card inherits it
            unless the card names its own, so an <span className="font-mono text-[11px]">@claude</span> request on any
            of them runs inside that codebase.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Directory</Label>
          <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} ariaLabel="Board project" />
        </div>

        {chosen ? (
          <div className="rounded-md border border-primary/25 bg-primary/8 p-2.5 text-xs">
            <p className="flex items-center gap-2 font-mono text-[11px] text-foreground">
              <FolderGit2 className="size-3.5 shrink-0 text-primary" />
              {shortPath(chosen.path)}
            </p>
            {chosen.description ? (
              <p className="mt-1.5 leading-snug text-muted-foreground">{chosen.description}</p>
            ) : null}
            {/* Said plainly, because this is the moment it becomes true. */}
            <p className="mt-1.5 leading-snug text-muted-foreground">
              Claude can read and change files in there when it answers a request on one of these cards.
            </p>
          </div>
        ) : null}

        {overrides > 0 ? (
          <p className="text-xs text-muted-foreground">
            {overrides} card{overrides > 1 ? "s" : ""} on this board name their own project and are unaffected by this.
          </p>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onManageProjects();
            }}
          >
            Manage projects
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
