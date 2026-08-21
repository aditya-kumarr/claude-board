import { useEffect, useMemo, useState } from "react";
import { Ban, Clock, Send, Trash2, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, Separator } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, relativeTime, toLocalInputValue, fromLocalInputValue } from "@/lib/format";
import {
  kindColor,
  priorityColor,
  PRIORITY_LABELS,
  type BoardColumn,
  type BoardDetail,
  type Priority,
  type TaskComment,
  type User,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
const UNASSIGNED = "__unassigned__";

export interface TaskDialogProps {
  taskId: string | null;
  boards: BoardDetail[];
  users: User[];
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/**
 * Detail view and editor for one card. Field edits save on blur (or on select)
 * rather than behind a Save button, so the board and the agent see changes
 * immediately; the comment box is the hand-off channel to Claude.
 */
export function TaskDialog({ taskId, boards, users, onClose, onChanged, onError }: TaskDialogProps) {
  const board = boards.find((entry) => entry.tasks.some((task) => task.id === taskId));
  const task = board?.tasks.find((entry) => entry.id === taskId) ?? null;
  const column = board?.columns.find((entry) => entry.id === task?.columnId) ?? null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void api
      .comments(taskId)
      .then(({ comments: list }) => !cancelled && setComments(list))
      .catch(() => !cancelled && setComments([]));
    return () => {
      cancelled = true;
    };
  }, [taskId, task?.updatedAt]);

  const patch = async (body: Parameters<typeof api.updateTask>[1]) => {
    if (!taskId) return;
    try {
      await api.updateTask(taskId, body);
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not save that change");
    }
  };

  const move = async (columnId: string) => {
    if (!taskId) return;
    try {
      await api.moveTask(taskId, { column: columnId, force: true });
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not move the task");
    }
  };

  const postComment = async () => {
    if (!taskId || !draft.trim()) return;
    setPosting(true);
    try {
      const comment = await api.addComment(taskId, draft.trim());
      setComments((current) => [...current, comment]);
      setDraft("");
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not post the comment");
    } finally {
      setPosting(false);
    }
  };

  const remove = async () => {
    if (!taskId || !window.confirm("Delete this task? This cannot be undone.")) return;
    try {
      await api.deleteTask(taskId);
      onClose();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not delete the task");
    }
  };

  const dueBounds = useMemo(
    () => ({
      min: board ? toLocalInputValue(board.board.startsAt) : undefined,
      max: board ? toLocalInputValue(board.board.endsAt) : undefined,
    }),
    [board?.board.startsAt, board?.board.endsAt],
  );

  const open = taskId !== null && task !== null && board !== undefined && column !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tint={kindColor(column.kind)}>{column.name}</Badge>
                <Badge tint={priorityColor(task.priority)}>{PRIORITY_LABELS[task.priority]}</Badge>
                {task.completedAt ? <Badge tint={kindColor("done")}>completed</Badge> : null}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{task.id}</span>
              </div>
              <DialogTitle asChild>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => title.trim() && title !== task.title && void patch({ title: title.trim() })}
                  onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                  className="h-auto border-0 bg-transparent px-0 text-base font-semibold shadow-none focus:shadow-none"
                  aria-label="Task title"
                />
              </DialogTitle>
              <DialogDescription>
                On <span className="font-medium text-foreground">{board.board.name}</span>, which closes{" "}
                {formatDateTime(board.board.endsAt)} · created by {task.createdBy === "claude" ? "Claude" : "you"}{" "}
                {relativeTime(task.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="State">
                <Select value={column.id} onValueChange={(value) => void move(value)}>
                  <SelectTrigger aria-label="State">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {board.columns.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        <span className="inline-flex items-center gap-2">
                          <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(entry.kind) }} />
                          {entry.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Assignee" hint="who does it">
                <Select
                  value={task.assigneeId ?? UNASSIGNED}
                  onValueChange={(value) => void patch({ assignee: value === UNASSIGNED ? null : value })}
                >
                  <SelectTrigger aria-label="Assignee">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <UserIcon className="size-3.5" /> Unassigned
                      </span>
                    </SelectItem>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        <span className="inline-flex items-center gap-2">
                          <Avatar
                            name={user.displayName}
                            tint={user.id === "claude" ? "var(--primary)" : "var(--kind-active)"}
                            size="sm"
                          />
                          {user.displayName}
                          {user.kind === "agent" ? (
                            <span className="text-[10px] text-muted-foreground">does the work</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Priority">
                <Select value={task.priority} onValueChange={(value) => void patch({ priority: value as Priority })}>
                  <SelectTrigger aria-label="Priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        <span className="inline-flex items-center gap-2">
                          <span className="size-2 rounded-full" style={{ backgroundColor: priorityColor(priority) }} />
                          {PRIORITY_LABELS[priority]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Due" hint="within the board window">
                <Input
                  type="datetime-local"
                  value={toLocalInputValue(task.dueAt)}
                  min={dueBounds.min}
                  max={dueBounds.max}
                  onChange={(event) => void patch({ dueAt: fromLocalInputValue(event.target.value) })}
                  aria-label="Due date"
                />
              </Field>
            </div>

            <Field label="Description">
              <Textarea
                value={description}
                placeholder="What does done look like?"
                onChange={(event) => setDescription(event.target.value)}
                onBlur={() =>
                  description !== (task.description ?? "") && void patch({ description: description || undefined })
                }
                className="min-h-24"
              />
            </Field>

            {column.kind === "blocked" || task.blockedReason ? (
              <Field label="Blocked because" hint="shown on the card">
                <Input
                  defaultValue={task.blockedReason ?? ""}
                  placeholder="Waiting on…"
                  onBlur={(event) =>
                    event.target.value !== (task.blockedReason ?? "") &&
                    void patch({ blockedReason: event.target.value || null })
                  }
                  className="border-l-2"
                  style={{ borderLeftColor: kindColor("blocked") }}
                />
              </Field>
            ) : null}

            <Separator />

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Thread
                <span className="rounded-full bg-muted px-1.5 text-[10px]">{comments.length}</span>
              </h3>

              <div className="max-h-52 space-y-2 overflow-y-auto pr-1 scrollbar-slim">
                {comments.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    No comments yet. Claude posts progress here on tasks assigned to it.
                  </p>
                ) : (
                  comments.map((comment) => {
                    const author = users.find((user) => user.id === comment.authorId);
                    const isAgent = author?.kind === "agent";
                    return (
                      <div
                        key={comment.id}
                        className={cn(
                          "rounded-md border p-2.5 text-[13px] leading-relaxed",
                          isAgent ? "border-primary/25 bg-primary/8" : "border-border/70 bg-surface/60",
                        )}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <Avatar
                            name={author?.displayName ?? comment.authorId}
                            tint={isAgent ? "var(--primary)" : "var(--kind-active)"}
                            size="sm"
                          />
                          <span className="text-xs font-medium">{author?.displayName ?? comment.authorId}</span>
                          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="size-3" />
                            {relativeTime(comment.createdAt)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-card-foreground">{comment.body}</p>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="flex items-end gap-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Leave a note for Claude…  (⌘↵ to send)"
                  className="min-h-10 flex-1"
                  rows={2}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void postComment();
                    }
                  }}
                />
                <Button onClick={() => void postComment()} loading={posting} disabled={!draft.trim()} size="sm">
                  <Send /> Send
                </Button>
              </div>
            </section>

            <Separator />

            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                Updated {relativeTime(task.updatedAt)}
                {task.blockedReason ? (
                  <span className="ml-2 inline-flex items-center gap-1" style={{ color: kindColor("blocked") }}>
                    <Ban className="size-3" /> blocked
                  </span>
                ) : null}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void remove()} className="text-destructive hover:bg-destructive/10">
                <Trash2 /> Delete task
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <Label hint={hint}>{label}</Label>
    {children}
  </div>
);
