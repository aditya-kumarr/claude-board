import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AtSign,
  Ban,
  Check,
  ChevronRight,
  CircleDashed,
  Clock,
  FolderGit2,
  ImagePlus,
  Loader2,
  Pencil,
  Send,
  Sparkles,
  Trash2,
  User as UserIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
// Title and description are Radix Dialog parts, so they serve the sheet unchanged.
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, Separator } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/tooltip";
import { Markdown } from "@/components/markdown";
import { agentHandles, hasAgentMention, MentionText } from "@/components/mention-text";
import { ProjectSelect, shortPath } from "@/components/project-select";
import { ResponseBoxes } from "@/components/response-boxes";
import { PhotoCarousel } from "@/components/photo-carousel";
import { ResponsePanel } from "@/components/response-panel";
import { api, ApiError } from "@/lib/api";
import { humanBytes, toBase64 } from "@/lib/files";
import { formatDateTime, relativeTime, toLocalInputValue, fromLocalInputValue } from "@/lib/format";
import {
  kindColor,
  MENTION_STATUS_LABELS,
  priorityColor,
  PRIORITY_LABELS,
  type BoardDetail,
  type MentionStatus,
  type MentionWithContext,
  type CommentKind,
  type Priority,
  type Project,
  type TaskComment,
  type TaskPhoto,
  type TaskResponseSummary,
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

/**
 * How each kind of comment reads in the thread.
 *
 * `note` gets no chrome at all — most of the thread is notes, and a badge on
 * every one of them is a badge on none of them. The other three are Claude
 * narrating a job, and `blocker` is the one the whole treatment exists for: it
 * is the only comment in a thread that is asking the user to do something.
 */
const COMMENT_KIND: Record<Exclude<CommentKind, "note">, { label: string; tint: string; icon: typeof Check }> = {
  progress: { label: "Progress", tint: "var(--kind-active)", icon: CircleDashed },
  blocker: { label: "Blocked", tint: "var(--kind-blocked)", icon: AlertTriangle },
  result: { label: "Result", tint: "var(--kind-done)", icon: Check },
};

export interface TaskDialogProps {
  taskId: string | null;
  boards: BoardDetail[];
  users: User[];
  /** Registered directories, for the picker and for naming the inherited one. */
  projects: Project[];
  /**
   * Moves when the revision poll sees a change made outside this tab. Draft
   * replies live off the board payload, so without this a rewrite Claude finished
   * would sit unseen in an open dialog — the card's own `updatedAt` does not move
   * when one of its replies is rewritten.
   */
  revisionKey: number | null;
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
/** Kept in step with core's limits, so a refusal happens before the upload. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface StagedImage {
  key: string;
  file: File;
  /** Object URL, revoked when the image is unstaged or sent. */
  preview: string;
}

export function TaskDialog({ taskId, boards, users, projects, revisionKey, onClose, onChanged, onError }: TaskDialogProps) {
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
  /** The sheet's scrolling body. The thread lives in it rather than in a box of its own. */
  const threadRef = useRef<HTMLDivElement>(null);
  /** Was the thread scrolled to the bottom before this render? */
  const threadPinnedRef = useRef(false);
  const [images, setImages] = useState<StagedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

  const [responses, setResponses] = useState<TaskResponseSummary>({ responses: [], activeDraftTurn: null });
  const [openResponseId, setOpenResponseId] = useState<string | null>(null);
  const [draftingReplies, setDraftingReplies] = useState(false);
  const [photos, setPhotos] = useState<TaskPhoto[]>([]);

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
    setOpenResponseId(null);
    // A card opens at its top — the details — not scrolled to the end of its
    // thread. Following new comments starts once the user scrolls down to them.
    threadPinnedRef.current = false;
    threadRef.current?.scrollTo({ top: 0 });
    setImages((current) => {
      for (const entry of current) URL.revokeObjectURL(entry.preview);
      return [];
    });
  }, [taskId]);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  /**
   * The thread, re-read on every remote change.
   *
   * `revisionKey` is the load-bearing dependency, not `task.updatedAt`: posting a
   * comment does not touch the task row, so keying this off the card's own
   * timestamp meant a run's progress comments did not appear in a dialog the user
   * had open — which is exactly the dialog they have open while it works.
   */
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
  }, [taskId, task?.updatedAt, board?.openMentions.length, revisionKey]);

  /**
   * Photos from the chat the card came out of. Keyed on the revision poll rather
   * than the card, because linking a photo does not touch the task row. Only a
   * card with a sourceRef can have any, so nothing else pays for the request.
   */
  useEffect(() => {
    if (!taskId || !task?.sourceRef?.startsWith("whatsapp:")) {
      setPhotos([]);
      return;
    }
    let cancelled = false;
    api
      .taskPhotos(taskId)
      .then(({ photos: list }) => !cancelled && setPhotos(list))
      .catch(() => {
        // Keep what is showing; the next poll retries.
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, task?.sourceRef, revisionKey]);

  /**
   * Keeps the newest comment in view as a run narrates, but only when the user is
   * already at the bottom — yanking the thread down while they are reading back
   * through what happened is worse than making them scroll.
   *
   * Whether they were at the bottom is recorded as they scroll rather than
   * measured here: by the time this runs the new comment is already laid out, so
   * the distance to the bottom is the height of the thing that just arrived.
   */
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && threadPinnedRef.current) thread.scrollTop = thread.scrollHeight;
  }, [comments]);

  /**
   * The card's draft replies, re-read on every remote change rather than on the
   * card's own timestamp: rewriting a reply does not touch the task row, so
   * keying this off `task.updatedAt` would leave the panel showing the old words.
   */
  const reloadResponses = useCallback(async () => {
    if (!taskId) return;
    try {
      setResponses(await api.taskResponses(taskId));
    } catch {
      // A failed read must not blank a panel the user is reading; the next poll retries.
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setResponses({ responses: [], activeDraftTurn: null });
      return;
    }
    void reloadResponses();
  }, [taskId, reloadResponses, revisionKey]);

  const openResponse = useMemo(
    () => responses.responses.find((entry) => entry.id === openResponseId) ?? null,
    [responses.responses, openResponseId],
  );

  /** Queues a drafting pass. Nothing is written yet when this resolves. */
  const requestDrafts = async () => {
    if (!taskId) return;
    setDraftingReplies(true);
    try {
      const { alreadyQueued } = await api.requestDrafts(taskId);
      await reloadResponses();
      onChanged();
      if (alreadyQueued) onError("A drafting pass for this card is already queued.");
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not ask for the replies");
    } finally {
      setDraftingReplies(false);
    }
  };

  const cancelDrafts = async () => {
    if (!taskId) return;
    try {
      await api.cancelDrafts(taskId);
      await reloadResponses();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not cancel that");
    }
  };

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

  /** Stages images for the next comment; anything but a readable image is refused here. */
  const addImages = (incoming: FileList | File[] | null | undefined) => {
    const files = [...(incoming ?? [])];
    if (files.length === 0) return;
    const accepted: StagedImage[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        onError(`${file.name || "That file"} is not an image the thread can hold — PNG, JPEG, GIF or WebP.`);
        continue;
      }
      if (file.size === 0) {
        onError(`${file.name || "That image"} is empty.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        onError(`${file.name || "That image"} is ${humanBytes(file.size)}; the limit is 10 MB.`);
        continue;
      }
      accepted.push({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, preview: URL.createObjectURL(file) });
    }
    setImages((current) => {
      const next = [...current, ...accepted];
      if (next.length > MAX_IMAGES) {
        onError(`Only ${MAX_IMAGES} images per comment — the rest were dropped.`);
        for (const entry of next.slice(MAX_IMAGES)) URL.revokeObjectURL(entry.preview);
      }
      return next.slice(0, MAX_IMAGES);
    });
  };

  const unstageImage = (key: string) =>
    setImages((current) =>
      current.filter((entry) => {
        if (entry.key === key) URL.revokeObjectURL(entry.preview);
        return entry.key !== key;
      }),
    );

  const postComment = async () => {
    if (!taskId || (!draft.trim() && images.length === 0)) return;
    setPosting(true);
    try {
      const encoded = await Promise.all(
        images.map(async (entry) => ({
          filename: entry.file.name || "pasted-image",
          mime: entry.file.type || undefined,
          data: await toBase64(entry.file),
        })),
      );
      const comment = await api.addComment(taskId, draft.trim(), encoded);
      // Posting is the user joining the conversation, so follow it from here.
      threadPinnedRef.current = true;
      setComments((current) => [...current, comment]);
      setDraft("");
      for (const entry of images) URL.revokeObjectURL(entry.preview);
      setImages([]);
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
  /**
   * The same card-then-board fallback core does, resolved here from data the
   * dialog already has: what matters to the user is the directory the work would
   * happen in, not which of the two rows happens to name it.
   */
  const boardProject = projects.find((project) => project.id === board?.board.projectId) ?? null;
  const taskProject = task?.projectId ? projects.find((project) => project.id === task.projectId) ?? null : null;
  const effectiveProject = taskProject ?? boardProject;
  const overdue =
    open && column.kind !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now();

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {/* Half the page from 1280px up, three quarters below it: wide enough to read
          a thread as a conversation, with the board still in view beside it. */}
      <SheetContent className="w-[75vw] max-w-none xl:w-1/2" aria-describedby={undefined}>
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

            <div
              ref={threadRef}
              onScroll={(event) => {
                const body = event.currentTarget;
                threadPinnedRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
              }}
              className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6 pt-5 scrollbar-slim"
            >
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

                  <div className="space-y-1.5 sm:col-span-2">
                    <Label hint="where the work happens">Project</Label>
                    <ProjectSelect
                      projects={projects}
                      value={task.projectId}
                      inheritFrom={boardProject}
                      onChange={(projectId) => void patch({ project: projectId })}
                    />
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {effectiveProject ? (
                        <>
                          An <span className="font-medium text-primary">@claude</span> request on this card runs inside{" "}
                          <span className="font-mono text-[10.5px] text-foreground">{effectiveProject.path}</span> and can
                          change code there.
                        </>
                      ) : (
                        "With no project, Claude can answer about this card but has no codebase to work in."
                      )}
                    </p>
                  </div>
                </div>
              ) : (
                <CollapsibleSection
                  id="details"
                  label="Details"
                  summary={[
                    column.name,
                    assignee?.displayName ?? "Unassigned",
                    PRIORITY_LABELS[task.priority],
                    task.dueAt ? `due ${formatDateTime(task.dueAt)}${overdue ? " (overdue)" : ""}` : "no due date",
                    effectiveProject?.name,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
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

                    <ReadField label="Project">
                      {effectiveProject ? (
                        <Hint
                          label={`${effectiveProject.path} — ${taskProject ? "set on this card" : "inherited from the board"}`}
                        >
                          <span className="inline-flex items-center gap-2">
                            <FolderGit2 className="size-3.5 shrink-0" style={{ color: "var(--kind-review)" }} />
                            <span className="truncate">{effectiveProject.name}</span>
                            <span className="font-mono text-[10.5px] text-muted-foreground">
                              {shortPath(effectiveProject.path)}
                            </span>
                            {taskProject && boardProject && taskProject.id !== boardProject.id ? (
                              <Badge variant="outline">overrides the board</Badge>
                            ) : null}
                          </span>
                        </Hint>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <FolderGit2 className="size-3.5" /> None
                        </span>
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
                </CollapsibleSection>
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

              {/* Right under the description: on a bug reported in a chat, the
                  screenshot usually is the description. */}
              {photos.length > 0 ? (
                <CollapsibleSection
                  id="photos"
                  label={photos.length === 1 ? "Photo from the chat" : `Photos from the chat · ${photos.length}`}
                  summary={photos.length === 1 ? "1 photo" : `${photos.length} photos`}
                >
                  <PhotoCarousel photos={photos} />
                </CollapsibleSection>
              ) : null}

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

              {/* Above the thread on purpose: on a card that came out of somebody's
                  mail, the reply owed back is the point of the card, and the thread
                  is the conversation *about* it. */}
              <ResponseBoxes
                summary={responses}
                imported={task.sourceRef !== null}
                busy={draftingReplies}
                onOpen={(response) => setOpenResponseId(response.id)}
                onRequestDrafts={() => void requestDrafts()}
                onCancelDrafts={() => void cancelDrafts()}
              />

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
                          ? "Claude is on it and posts each step in the thread below as it goes."
                          : "Claude answers in this thread — next time it reads the board, or straight away if the mention watcher is running."}
                      </p>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  {comments.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">
                      No comments yet. Claude posts each step of its work here — and write{" "}
                      <span className="font-medium text-primary">@claude</span> to ask it for something on this card.
                    </p>
                  ) : (
                    comments.map((comment) => {
                      const author = users.find((user) => user.id === comment.authorId);
                      const isAgent = author?.kind === "agent";
                      const ask = mentionByComment.get(comment.id);
                      const kind = comment.kind === "note" ? null : COMMENT_KIND[comment.kind];
                      const KindIcon = kind?.icon;
                      // A comment that asked for something is left-ruled in its
                      // request's colour, so the thread shows at a glance which
                      // notes were asks and which were just notes. A result rules
                      // itself the same way; a blocker takes the whole card,
                      // because it is the one comment asking the user to act.
                      const rule = ask
                        ? { borderLeftWidth: 2, borderLeftColor: MENTION_TINT[ask.status] }
                        : comment.kind === "blocker" && kind
                          ? {
                              borderLeftWidth: 2,
                              borderLeftColor: kind.tint,
                              borderColor: `color-mix(in oklab, ${kind.tint} 40%, transparent)`,
                              backgroundColor: `color-mix(in oklab, ${kind.tint} 8%, transparent)`,
                            }
                          : comment.kind === "result" && kind
                            ? { borderLeftWidth: 2, borderLeftColor: kind.tint }
                            : undefined;
                      return (
                        <div
                          key={comment.id}
                          className={cn(
                            "rounded-md border p-2.5 text-[13px] leading-relaxed",
                            isAgent ? "border-primary/25 bg-primary/8" : "border-border/70 bg-surface/60",
                            // A step in a long run is the background noise of the
                            // thread; the blocker and the result are the two the
                            // user came to read, so only those keep full weight.
                            comment.kind === "progress" && "border-border/60 bg-surface/50",
                          )}
                          style={rule}
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <Avatar
                              name={author?.displayName ?? comment.authorId}
                              tint={isAgent ? "var(--primary)" : "var(--kind-active)"}
                              size="sm"
                            />
                            <span className="text-xs font-medium">{author?.displayName ?? comment.authorId}</span>
                            {kind && KindIcon ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ring-1 ring-inset"
                                style={{
                                  color: kind.tint,
                                  backgroundColor: `color-mix(in oklab, ${kind.tint} 12%, transparent)`,
                                  // @ts-expect-error CSS custom property for the ring color
                                  "--tw-ring-color": `color-mix(in oklab, ${kind.tint} 30%, transparent)`,
                                }}
                              >
                                <KindIcon className="size-2.5" />
                                {kind.label}
                              </span>
                            ) : null}
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
                          {/* Claude writes markdown; the human writes into a plain
                              box with no formatting affordance, so reinterpreting
                              their asterisks would be a change they did not ask
                              for. Both paths highlight mentions identically. */}
                          {isAgent ? (
                            <Markdown text={comment.body} handles={handles} className="text-card-foreground" />
                          ) : (
                            <MentionText text={comment.body} handles={handles} className="text-card-foreground" />
                          )}
                          {comment.attachments.length > 0 ? (
                            <div className={cn("flex flex-wrap gap-1.5", comment.body && "mt-2")}>
                              {comment.attachments.map((image) => (
                                <a
                                  key={image.id}
                                  href={api.commentImageUrl(image.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={`${image.filename} — open full size`}
                                  className="block overflow-hidden rounded border border-border/60 bg-surface/60 transition-colors hover:border-ring/45"
                                >
                                  <img
                                    src={api.commentImageUrl(image.id)}
                                    alt={image.filename}
                                    loading="lazy"
                                    className="h-32 max-w-[16rem] object-cover"
                                  />
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
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
            </div>

            {/* Pinned under the scrolling body, as a chat's composer is: the thread
                is the conversation every session on this card shares, and answering
                it should not mean scrolling back down to find the box. */}
            <div
              className={cn(
                "shrink-0 space-y-1.5 border-t border-border/70 bg-elevated px-6 pb-4 pt-3 transition-colors",
                dragOver && "bg-primary/8",
              )}
              onDragOver={(event) => {
                if (![...event.dataTransfer.types].includes("Files")) return;
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                setDragOver(false);
                addImages(event.dataTransfer.files);
              }}
            >
              {images.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {images.map((entry) => (
                    <span key={entry.key} className="relative">
                      <img
                        src={entry.preview}
                        alt={entry.file.name}
                        className="size-14 rounded border border-border/70 object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => unstageImage(entry.key)}
                        className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-border bg-elevated text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${entry.file.name || "image"}`}
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <Textarea
                ref={draftRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  // A screenshot off the clipboard becomes an attachment, not text.
                  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
                  if (files.length > 0) {
                    event.preventDefault();
                    addImages(files);
                  }
                }}
                placeholder="Leave a note, or @claude to ask for something…  Paste or drop images."
                className={cn("min-h-16 w-full", draftAsksClaude && "border-primary/45")}
                rows={2}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void postComment();
                  }
                }}
              />
              {/* The actions sit under the box, as in any chat: the box keeps the full
                  width for what is being written, and Send stays where the eye ends. */}
              <div className="flex items-center gap-1">
                <Hint label="Attach images — or paste or drop them here" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => imageInput.current?.click()}
                    aria-label="Attach images"
                    className="h-7 px-2 text-muted-foreground hover:text-foreground"
                  >
                    <ImagePlus /> Image
                  </Button>
                </Hint>
                <Hint label="Ask Claude to do something on this card" side="top">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={askClaude}
                    aria-label="Ask Claude"
                    className={cn(
                      "h-7 px-2 text-muted-foreground hover:text-foreground",
                      draftAsksClaude && "bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary",
                    )}
                  >
                    <AtSign /> Claude
                  </Button>
                </Hint>
                <span className="ml-auto hidden text-[10.5px] text-muted-foreground sm:inline">⌘↵ to send</span>
                <Button
                  onClick={() => void postComment()}
                  loading={posting}
                  disabled={!draft.trim() && images.length === 0}
                  size="sm"
                  className="ml-2"
                >
                  <Send /> Send
                </Button>
              </div>
              {/* The one thing worth spelling out: a mention is not just a note. */}
              <p
                className={cn(
                  "text-[11px] transition-colors",
                  draftAsksClaude ? "font-medium text-primary" : "text-muted-foreground",
                )}
              >
                {draftAsksClaude
                  ? effectiveProject
                    ? `Sending this asks Claude to act on it — in ${shortPath(effectiveProject.path)} — and tracks the request until it replies.`
                    : "Sending this asks Claude to act on it, and tracks the request until it replies."
                  : "Mentioning @claude turns a comment into a request Claude is expected to carry out."}
              </p>
                          <input
                ref={imageInput}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple
                className="hidden"
                onChange={(event) => {
                  addImages(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </>
        ) : null}
      </SheetContent>

      {/* A sheet over the dialog rather than a route: the card stays visible
          behind it, which is what makes the message readable in context. */}
      <ResponsePanel
        response={openResponse}
        onClose={() => setOpenResponseId(null)}
        onChanged={() => {
          void reloadResponses();
          onChanged();
        }}
        onError={onError}
      />
    </Sheet>
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

/** Whether a collapsible section is open, remembered per section in this browser. */
function useSectionOpen(id: string): [boolean, () => void] {
  const key = `automation.taskDialog.${id}.open`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "false";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((current) => {
      try {
        localStorage.setItem(key, String(!current));
      } catch {
        // Private window or blocked storage: it just will not be remembered.
      }
      return !current;
    });
  return [open, toggle];
}

/**
 * A read-only block that folds away. Remembered across cards rather than per
 * card: someone who closes the photos is saying they do not want them in the
 * way, not that this one card's photos were dull. Collapsed, the heading keeps
 * a one-line summary so the section still says what is in it.
 */
function CollapsibleSection({
  id,
  label,
  summary,
  children,
}: {
  id: string;
  label: string;
  summary?: string;
  children: React.ReactNode;
}) {
  const [open, toggle] = useSectionOpen(id);
  return (
    <section className="space-y-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
        {!open && summary ? (
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">· {summary}</span>
        ) : null}
      </button>
      {open ? children : null}
    </section>
  );
}

/** Heading for a read-only block — `Label` styling without a control to point at. */
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
);
