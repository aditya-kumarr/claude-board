import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar } from "@/components/ui/misc";
import { ProjectSelect, shortPath } from "@/components/project-select";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, toLocalInputValue } from "@/lib/format";
import {
  kindColor,
  priorityColor,
  PRIORITY_LABELS,
  type BoardDetail,
  type Priority,
  type Project,
  type User,
} from "@/lib/types";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
const UNASSIGNED = "__unassigned__";

export function CreateTaskDialog({
  board,
  users,
  projects,
  defaultColumnId,
  open,
  onOpenChange,
  onCreated,
}: {
  board: BoardDetail | null;
  users: User[];
  projects: Project[];
  defaultColumnId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState("");
  const [assignee, setAssignee] = useState<string>(UNASSIGNED);
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueAt, setDueAt] = useState("");
  /** `null` means "inherit the board's", which is the right default for most cards. */
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !board) return;
    setColumnId(defaultColumnId ?? board.columns[0]?.id ?? "");
    setTitle("");
    setDescription("");
    setAssignee(UNASSIGNED);
    setPriority("medium");
    setDueAt("");
    setProjectId(null);
    setError(null);
  }, [open, board?.board.id, defaultColumnId]);

  const boardProject = projects.find((project) => project.id === board?.board.projectId) ?? null;
  const effectiveProject = (projectId ? projects.find((project) => project.id === projectId) : null) ?? boardProject;

  const submit = async () => {
    if (!board) return;
    if (!title.trim()) {
      setError("A task needs a title");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createTask(board.board.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        column: columnId || undefined,
        assignee: assignee === UNASSIGNED ? null : assignee,
        priority,
        // Left empty, the server inherits the board's deadline.
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        // Left unset, the card inherits the board's project — not "no project".
        project: projectId ?? undefined,
      });
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the task");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open && board !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            {board ? (
              <>
                On <span className="font-medium text-foreground">{board.board.name}</span>. Leave the due date empty and
                it inherits the board deadline, {formatDateTime(board.board.endsAt)}.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Title</Label>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Write the migration runner"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label hint="optional">Detail</Label>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Acceptance criteria, links, constraints."
            rows={3}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>State</Label>
            <Select value={columnId} onValueChange={setColumnId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {board?.columns.map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(column.kind) }} />
                      {column.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Assign to</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Nobody yet</SelectItem>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    <span className="inline-flex items-center gap-2">
                      <Avatar
                        name={user.displayName}
                        tint={user.id === "claude" ? "var(--primary)" : "var(--kind-active)"}
                        size="sm"
                      />
                      {user.displayName}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: priorityColor(entry) }} />
                      {PRIORITY_LABELS[entry]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label hint="board end by default">Due</Label>
            <Input
              type="datetime-local"
              value={dueAt}
              min={board ? toLocalInputValue(board.board.startsAt) : undefined}
              max={board ? toLocalInputValue(board.board.endsAt) : undefined}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </div>

          {/* Full width and last: on most boards the answer is "the board's", and
              a card that belongs to a different checkout is the exception. */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label hint="where the work happens">Project</Label>
            <ProjectSelect
              projects={projects}
              value={projectId}
              inheritFrom={boardProject}
              onChange={setProjectId}
            />
          </div>
        </div>

        {assignee === "claude" ? (
          <p className="flex items-start gap-2 rounded-md border border-primary/25 bg-primary/8 p-2.5 text-xs text-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
            Claude picks this up from <span className="font-mono text-[11px]">my_queue</span> over the MCP server, works
            it, and reports back in the task thread.
            {effectiveProject ? (
              <>
                {" "}
                An <span className="font-mono text-[11px]">@claude</span> request on it runs inside{" "}
                <span className="font-mono text-[11px]">{shortPath(effectiveProject.path)}</span>.
              </>
            ) : null}
          </p>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Add task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
