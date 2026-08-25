import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Ban, Check, Clock, Loader2, Pencil, Send, Sparkles, Trash2, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, Separator } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/tooltip";
import { agentHandles, hasAgentMention, MentionText } from "@/components/mention-text";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, relativeTime, toLocalInputValue, fromLocalInputValue } from "@/lib/format";
import {
  kindColor,
  MENTION_STATUS_LABELS,
  priorityColor,
  PRIORITY_LABELS,
  type BoardDetail,
  type MentionStatus,
  type MentionWithContext,
  type Priority,
  type TaskComment,
  type User,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
const UNASSIGNED = "__unassigned__";

/** Open requests read as live; resolved ones recede into the thread. */
const MENTION_TINT: Record<MentionStatus, string> = {
  pending: "var(--kind-review)",
  claimed: "var(--primary)",
  answered: "var(--kind-done)",
  dismissed: "var(--muted-foreground)",
};

export interface TaskDialogProps {
  taskId: string | null;
  boards: BoardDetail[];
  users: User[];
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/**
 * Detail view and editor for one card. It opens **read-only** so the card can be
 * read without risk of nudging a field; the pencil in the top-left corner unlocks
 * the form. Once editing, field edits save on blur (or on select) rather than
 * behind a Save button, so the board and the agent see changes immediately. The
 * comment box stays live in both modes — it is the hand-off channel to Claude,
 * not an edit to the card.
 */
export function TaskDialog({ taskId, boards, users, onClose, onChanged, onError }: TaskDialogProps) {
  const board = boards.find((entry) => entry.tasks.some((task) => task.id === taskId));
  const task = board?.tasks.find((entry) => entry.id === taskId) ?? null;
  const column = board?.columns.find((entry) => entry.id === task?.columnId) ?? null;

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [mentions, setMentions] = useState<MentionWithContext[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const handles = useMemo(() => agentHandles(users), [users]);
  /** Which comments asked Claude for something, and where each ask got to. */
  const mentionByComment = useMemo(
    () => new Map(mentions.map((mention) => [mention.commentId, mention])),
    [mentions],
  );
  const openMentions = useMemo(
    () => mentions.filter((mention) => mention.status === "pending" || mention.status === "claimed"),
    [mentions],
  );
  const draftAsksClaude = hasAgentMention(draft, handles);

  /** Every card opens read-only, including the next one opened without closing the dialog. */
  useEffect(() => {
    setEditing(false);
  }, [taskId]);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  // Re-runs on the board's revision-driven refetch too, so a request Claude
  // answered from an MCP session lands in an open dialog without a reload.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void Promise.all([api.comments(taskId), api.mentions(taskId)])
      .then(([{ comments: list }, { mentions: asks }]) => {
        if (cancelled) return;
        setComments(list);
        setMentions(asks);
      })
      .catch(() => {
        if (cancelled) return;
        setComments([]);
        setMentions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, task?.updatedAt, board?.openMentions.length]);

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
      // The POST reports the requests it raised, but not their joined context, so
      // re-read the thread's mentions rather than guessing at the shape.
      if (comment.mentions.length > 0) {
        await api.mentions(taskId).then(({ mentions: asks }) => setMentions(asks)).catch(() => undefined);
      }
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not post the comment");
    } finally {
      setPosting(false);
    }
  };

  /** Drops `@claude ` into the draft and focuses it — the ask is one tap away. */
  const askClaude = () => {
    setDraft((current) => (hasAgentMention(current, handles) ? current : `@claude ${current}`.trimEnd() + " "));
    requestAnimationFrame(() => {
      const field = draftRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
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
  const assignee = open ? users.find((user) => user.id === task.assigneeId) : undefined;
  const overdue =
    open && column.kind !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <>
            {/* Sits directly under the dialog's close button and matches its shape,
                so the two read as one stack of window controls. */}
            <Hint label={editing ? "Done editing" : "Edit this card"} side="left">
              <button
                type="button"
                onClick={() => setEditing((current) => !current)}
                aria-label={editing ? "Done editing" : "Edit task"}
                aria-pressed={editing}
                className={cn(
                  "absolute right-3.5 top-11 z-10 rounded-sm p-1 transition-[opacity,background-color,color]",
                  editing
                    ? "bg-primary/12 text-primary opacity-100 hover:bg-primary/20"
                    : "text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100",
                )}
              >
                {editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
              </button>
            </Hint>

            <DialogHeader className="pr-10">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tint={kindColor(column.kind)}>{column.name}</Badge>
                <Badge tint={priorityColor(task.priority)}>{PRIORITY_LABELS[task.priority]}</Badge>
                {task.completedAt ? <Badge tint={kindColor("done")}>completed</Badge> : null}
                {openMentions.length > 0 ? (
                  <Badge tint={MENTION_TINT[openMentions[0]!.status]}>
                    {MENTION_STATUS_LABELS[openMentions[0]!.status]}
                  </Badge>
                ) : null}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{task.id}</span>
              </div>
              {editing ? (
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
              ) : (
                <DialogTitle className="text-[17px] font-semibold leading-snug text-balance">
                  {task.title}
                </DialogTitle>
              )}
              <DialogDescription>
                On <span className="font-medium text-foreground">{board.board.name}</span>, which closes{" "}
                {formatDateTime(board.board.endsAt)} · created by {task.createdBy === "claude" ? "Claude" : "you"}{" "}
                {relativeTime(task.createdAt)}
              </DialogDescription>
            </DialogHeader>

            {editing ? (
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
                            <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: priorityColor(priority) }}
                            />
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
            ) : (
              <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                <ReadField label="State">
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(column.kind) }} />
                    {column.name}
                  </span>
                </ReadField>

                <ReadField label="Assignee">
                  {assignee ? (
                    <span className="inline-flex items-center gap-2">
                      <Avatar
                        name={assignee.displayName}
                        tint={assignee.id === "claude" ? "var(--primary)" : "var(--kind-active)"}
                        size="sm"
                      />
                      {assignee.displayName}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <UserIcon className="size-3.5" /> Unassigned
                    </span>
                  )}
                </ReadField>

                <ReadField label="Priority">
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: priorityColor(task.priority) }} />
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                </ReadField>

                <ReadField label="Due">
                  {task.dueAt ? (
                    <span className={cn("inline-flex items-center gap-1.5", overdue && "font-medium text-destructive")}>
                      {formatDateTime(task.dueAt)}
                      {overdue ? <span className="text-[11px] uppercase tracking-wide">overdue</span> : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No due date</span>
                  )}
                </ReadField>

                {task.completedAt ? (
                  <ReadField label="Completed">
                    <span className="inline-flex items-center gap-1.5" style={{ color: kindColor("done") }}>
                      <Check className="size-3.5" />
                      {formatDateTime(task.completedAt)}
                    </span>
                  </ReadField>
                ) : null}
              </dl>
            )}

            {editing ? (
              <Field label="Description">
                <Textarea
                  value={description}
                  placeholder="What does done look like?"
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={() =>
                    description !== (task.description ?? "") && void patch({ description: description || undefined })
                  }
                  className="min-h-32 leading-relaxed"
                />
              </Field>
            ) : (
              <section className="space-y-1.5">
                <SectionLabel>Description</SectionLabel>
                {task.description ? (
                  <p className="max-w-prose whitespace-pre-wrap break-words rounded-md border border-border/60 bg-surface/50 p-3 text-[13.5px] leading-[1.7] text-card-foreground">
                    {task.description}
                  </p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No description. Use the pencil to add one.
                  </p>
                )}
              </section>
            )}

            {column.kind === "blocked" || task.blockedReason ? (
              editing ? (
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
              ) : (
                <section className="space-y-1.5">
                  <SectionLabel>Blocked because</SectionLabel>
                  <p
                    className="whitespace-pre-wrap break-words border-l-2 pl-3 text-[13.5px] leading-relaxed text-card-foreground"
                    style={{ borderLeftColor: kindColor("blocked") }}
                  >
                    {task.blockedReason ?? "Reason not recorded."}
                  </p>
                </section>
              )
            ) : null}

            <Separator />

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Thread
                <span className="rounded-full bg-muted px-1.5 text-[10px]">{comments.length}</span>
              </h3>

              {/* Says out loud that the ask was registered. Without it a highlighted
                  word is the only evidence, which is not evidence. */}
              {openMentions.length > 0 ? (
                <div
                  className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12.5px] leading-relaxed"
                  style={{
                    borderColor: `color-mix(in oklab, ${MENTION_TINT[openMentions[0]!.status]} 35%, transparent)`,
                    backgroundColor: `color-mix(in oklab, ${MENTION_TINT[openMentions[0]!.status]} 8%, transparent)`,
                  }}
                >
                  {openMentions[0]!.status === "claimed" ? (
                    <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" style={{ color: MENTION_TINT.claimed }} />
                  ) : (
                    <Sparkles className="mt-0.5 size-3.5 shrink-0" style={{ color: MENTION_TINT.pending }} />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium" style={{ color: MENTION_TINT[openMentions[0]!.status] }}>
                      {openMentions.length === 1
                        ? MENTION_STATUS_LABELS[openMentions[0]!.status]
                        : `${openMentions.length} requests waiting for Claude`}
                    </p>
                    <p className="text-muted-foreground">
                      {openMentions[0]!.status === "claimed"
                        ? "Claude has picked this up and will reply in the thread."
                        : "Claude answers in this thread — next time it reads the board, or straight away if the mention watcher is running."}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="max-h-52 space-y-2 overflow-y-auto pr-1 scrollbar-slim">
                {comments.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    No comments yet. Claude posts progress here on tasks assigned to it — and write{" "}
                    <span className="font-medium text-primary">@claude</span> to ask it for something on this card.
                  </p>
                ) : (
                  comments.map((comment) => {
                    const author = users.find((user) => user.id === comment.authorId);
                    const isAgent = author?.kind === "agent";
                    const ask = mentionByComment.get(comment.id);
                    return (
                      <div
                        key={comment.id}
                        className={cn(
                          "rounded-md border p-2.5 text-[13px] leading-relaxed",
                          isAgent ? "border-primary/25 bg-primary/8" : "border-border/70 bg-surface/60",
                        )}
                        // A comment that asked for something is left-ruled in its
                        // request's colour, so the thread shows at a glance which
                        // notes were asks and which were just notes.
                        style={ask ? { borderLeftWidth: 2, borderLeftColor: MENTION_TINT[ask.status] } : undefined}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <Avatar
                            name={author?.displayName ?? comment.authorId}
                            tint={isAgent ? "var(--primary)" : "var(--kind-active)"}
                            size="sm"
                          />
                          <span className="text-xs font-medium">{author?.displayName ?? comment.authorId}</span>
                          {ask ? (
                            <Hint
                              label={
                                ask.resolution
                                  ? `${MENTION_STATUS_LABELS[ask.status]} — ${ask.resolution}`
                                  : MENTION_STATUS_LABELS[ask.status]
                              }
                            >
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ring-1 ring-inset"
                                style={{
                                  color: MENTION_TINT[ask.status],
                                  backgroundColor: `color-mix(in oklab, ${MENTION_TINT[ask.status]} 12%, transparent)`,
                                  // @ts-expect-error CSS custom property for the ring color
                                  "--tw-ring-color": `color-mix(in oklab, ${MENTION_TINT[ask.status]} 30%, transparent)`,
                                }}
                              >
                                <AtSign className="size-2.5" />
                                {MENTION_STATUS_LABELS[ask.status]}
                              </span>
                            </Hint>
                          ) : null}
                          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="size-3" />
                            {relativeTime(comment.createdAt)}
                          </span>
                        </div>
                        <MentionText text={comment.body} handles={handles} className="text-card-foreground" />
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={draftRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Leave a note, or @claude to ask for something…  (⌘↵ to send)"
                    className={cn("min-h-10 flex-1", draftAsksClaude && "border-primary/45")}
                    rows={2}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void postComment();
                      }
                    }}
                  />
                  <div className="flex flex-col gap-1.5">
                    <Hint label="Ask Claude to do something on this card" side="left">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={askClaude}
                        aria-label="Ask Claude"
                        className={cn(
                          "justify-center",
                          draftAsksClaude && "bg-primary/12 text-primary hover:bg-primary/20",
                        )}
                      >
                        <AtSign /> Claude
                      </Button>
                    </Hint>
                    <Button onClick={() => void postComment()} loading={posting} disabled={!draft.trim()} size="sm">
                      <Send /> Send
                    </Button>
                  </div>
                </div>
                {/* The one thing worth spelling out: a mention is not just a note. */}
                <p
                  className={cn(
                    "text-[11px] transition-colors",
                    draftAsksClaude ? "font-medium text-primary" : "text-muted-foreground",
                  )}
                >
                  {draftAsksClaude
                    ? "Sending this asks Claude to act on it, and tracks the request until it replies."
                    : "Mentioning @claude turns a comment into a request Claude is expected to carry out."}
                </p>
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
              {editing ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove()}
                  className="text-destructive hover:bg-destructive/10"
                >
                  <Trash2 /> Delete task
                </Button>
              ) : null}
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

/** Read-only counterpart to `Field` — same rhythm, no control. */
const ReadField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="space-y-1">
    <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
    <dd className="text-[13px] text-card-foreground">{children}</dd>
  </div>
);

/** Heading for a read-only block — `Label` styling without a control to point at. */
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
);
