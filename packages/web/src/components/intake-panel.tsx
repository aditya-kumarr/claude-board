import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Table,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type {
  BoardDetail,
  IntakeAttachment,
  IntakeMessageWithFiles,
  IntakeRejection,
  Task,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Kept in step with the server's own caps, so a refusal happens before the upload. */
const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;

/** Extensions the server can turn into text or open. Anything else is refused here. */
const ACCEPTED =
  ".csv,.tsv,.txt,.md,.markdown,.json,.yaml,.yml,.log,.xml,.html,.htm,.ics,.eml,.rtf," +
  ".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf";

interface Staged {
  key: string;
  file: File;
  /** Object URL for an image, so it can be seen before it is sent. */
  preview: string | null;
}

const humanBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Base64 without the data-URL prefix, which is what the API wants. */
async function toBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a 10MB file blows the argument limit.
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/**
 * Rough shape of a pasted block, shown on the bubble. "12 rows × 4 columns" tells
 * the user their spreadsheet arrived intact; "412 characters" tells them nothing.
 */
function describe(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  const first = lines[0] ?? "";
  const commas = (first.match(/,/g) ?? []).length;
  const tabs = (first.match(/\t/g) ?? []).length;
  if (lines.length > 1 && (commas >= 1 || tabs >= 1)) {
    return `${lines.length} rows × ${(tabs > commas ? tabs : commas) + 1} columns`;
  }
  return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
}

export interface IntakePanelProps {
  board: BoardDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Moves when the revision poll sees a change, which is when cards have landed. */
  revisionKey: number | null;
  onChanged: () => void;
  onOpenTask: (taskId: string) => void;
  onError: (message: string) => void;
}

/**
 * A chat on the board for turning raw material into cards.
 *
 * The premise is that work rarely arrives as a task list. It arrives as a CSV
 * somebody exported, the notes from a call, a forwarded thread, a photo of a
 * whiteboard. So the composer takes all of it — type into it, paste into it, drop
 * files on it — and the conversation above shows what Claude made of each one, with
 * the cards it created as chips you can click straight through to.
 *
 * Sending **queues**, like everything else here that needs a model: the API process
 * cannot read a CSV into tasks. The composer locks while a message is in flight,
 * because two runs reading the same paste would create the cards twice.
 */
export function IntakePanel({
  board,
  open,
  onOpenChange,
  revisionKey,
  onChanged,
  onOpenTask,
  onError,
}: IntakePanelProps) {
  const [messages, setMessages] = useState<IntakeMessageWithFiles[]>([]);
  const [instruction, setInstruction] = useState("");
  const [pasted, setPasted] = useState("");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [rejected, setRejected] = useState<IntakeRejection[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const boardId = board?.board.id ?? null;
  const inFlight = useMemo(
    () => messages.find((message) => message.status === "pending" || message.status === "claimed") ?? null,
    [messages],
  );
  const tasksById = useMemo(
    () => new Map((board?.tasks ?? []).map((task) => [task.id, task])),
    [board?.tasks],
  );

  const reload = useCallback(async () => {
    if (!boardId) return;
    try {
      const { messages: list } = await api.intake(boardId);
      setMessages(list);
    } catch {
      // A failed read must not blank a conversation being read; the poll retries.
    }
  }, [boardId]);

  useEffect(() => {
    if (!open || !boardId) return;
    void reload();
  }, [open, boardId, reload, revisionKey]);

  /** Stick to the newest message, which is where a reply appears. */
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, inFlight?.status, open]);

  /** Object URLs are only valid until revoked, so they are cleaned up on unstage. */
  useEffect(
    () => () => {
      for (const entry of staged) if (entry.preview) URL.revokeObjectURL(entry.preview);
    },
    [staged],
  );

  const addFiles = (incoming: FileList | File[]) => {
    const files = [...incoming];
    if (files.length === 0) return;
    const problems: IntakeRejection[] = [];
    const accepted: Staged[] = [];

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        problems.push({ filename: file.name, reason: `too big — ${humanBytes(file.size)}, limit ${humanBytes(MAX_BYTES)}` });
        continue;
      }
      const extension = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
      // An unnamed clipboard image has no extension, so its type is what decides.
      const usable = ACCEPTED.includes(extension) || file.type.startsWith("image/") || file.type === "application/pdf";
      if (!usable) {
        problems.push({
          filename: file.name || "unnamed file",
          reason: "not a kind that can be read — export it to CSV or PDF, or paste the text",
        });
        continue;
      }
      accepted.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${accepted.length}`,
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    }

    setRejected(problems);
    setStaged((current) => [...current, ...accepted].slice(0, MAX_FILES));
    if (accepted.length + staged.length > MAX_FILES) {
      onError(`Only ${MAX_FILES} files per message — the rest were dropped.`);
    }
  };

  /**
   * A paste is either files (a screenshot off the clipboard) or text. Big text goes
   * into its own block rather than the instruction box, because a 200-row CSV in a
   * two-line composer is unreadable and unrecoverable if you meant to type after it.
   */
  const onPaste = (event: React.ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const looksLikeData = text.includes("\n") && text.trim().split("\n").length > 2;
    if (looksLikeData) {
      event.preventDefault();
      setPasted((current) => (current ? `${current}\n${text}` : text));
    }
  };

  const send = async () => {
    if (!boardId || sending || inFlight) return;
    if (!instruction.trim() && !pasted.trim() && staged.length === 0) return;
    setSending(true);
    setRejected([]);
    try {
      const attachments = await Promise.all(
        staged.map(async (entry) => ({
          filename: entry.file.name || "pasted",
          mime: entry.file.type || undefined,
          data: await toBase64(entry.file),
        })),
      );
      const { rejected: refused } = await api.postIntake(boardId, {
        instruction: instruction.trim() || undefined,
        content: pasted.trim() ? pasted : undefined,
        attachments,
      });
      setInstruction("");
      setPasted("");
      for (const entry of staged) if (entry.preview) URL.revokeObjectURL(entry.preview);
      setStaged([]);
      setRejected(refused);
      await reload();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not send that");
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!boardId) return;
    try {
      await api.cancelIntake(boardId);
      await reload();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not cancel that");
    }
  };

  const remove = async (messageId: string) => {
    try {
      await api.deleteIntakeMessage(messageId);
      await reload();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not remove that");
    }
  };

  const canSend = Boolean(instruction.trim() || pasted.trim() || staged.length > 0);

  return (
    <Sheet open={open && board !== null} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-2xl gap-0 p-0" aria-describedby={undefined}>
        <header className="shrink-0 space-y-1 border-b border-border/70 px-5 pb-3.5 pt-4 pr-12">
          <SheetTitle className="flex items-center gap-2 text-[15px] font-semibold">
            <Sparkles className="size-4 text-primary" />
            Make cards from anything
          </SheetTitle>
          <SheetDescription className="text-[12px]">
            Paste a CSV, notes from a call, a thread, a screenshot — say what you want made of it, and Claude
            turns it into cards on <span className="font-medium text-foreground">{board?.board.name}</span>.
          </SheetDescription>
        </header>

        {/* ---- the conversation ---- */}
        <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 scrollbar-slim">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-6 text-center">
              <Upload className="mx-auto size-5 text-muted-foreground/60" />
              <p className="mt-2 text-[13px] font-medium text-muted-foreground">Nothing pasted yet</p>
              <p className="mx-auto mt-1 max-w-72 text-[11.5px] text-muted-foreground/75">
                A spreadsheet export, the notes from a standup, a photo of a whiteboard. Drop it below and say
                what shape you want the cards in.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBlock
                key={message.id}
                message={message}
                tasksById={tasksById}
                onOpenTask={onOpenTask}
                onRemove={() => void remove(message.id)}
              />
            ))
          )}
        </div>

        {/* ---- the composer ---- */}
        <div
          className={cn(
            "shrink-0 border-t border-border/70 bg-surface/40 px-5 pb-4 pt-3 transition-colors",
            dragOver && "bg-primary/8",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
          }}
        >
          {rejected.length > 0 ? (
            <div
              className="mb-2 space-y-1 rounded-md border px-2.5 py-2 text-[12px]"
              style={{
                borderColor: "color-mix(in oklab, var(--prio-high) 35%, transparent)",
                backgroundColor: "color-mix(in oklab, var(--prio-high) 8%, transparent)",
              }}
            >
              {rejected.map((entry) => (
                <p key={entry.filename} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" style={{ color: "var(--prio-high)" }} />
                  <span>{entry.reason}</span>
                </p>
              ))}
            </div>
          ) : null}

          {inFlight ? (
            <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/8 px-2.5 py-2 text-[12.5px]">
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-primary">
                  {inFlight.status === "pending" ? "Queued for Claude" : "Claude is reading it"}
                </p>
                <p className="text-muted-foreground">
                  Cards appear on the board as they are created. `bun run watch:intake` is what picks this up.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void cancel()}
                className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              {/* Pasted data gets its own block, separate from what you typed: they
                  are different things and mixing them makes both unreadable. */}
              {pasted ? (
                <div className="mb-2 rounded-md border border-border/70 bg-background/60">
                  <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px]">
                    <Table className="size-3 text-muted-foreground" />
                    <span className="font-medium">Pasted data</span>
                    <span className="text-muted-foreground">{describe(pasted)}</span>
                    <button
                      type="button"
                      onClick={() => setPasted("")}
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      aria-label="Remove the pasted data"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                  <pre className="max-h-28 overflow-auto px-2.5 py-1.5 font-mono text-[10.5px] leading-snug text-muted-foreground scrollbar-slim">
                    {pasted}
                  </pre>
                </div>
              ) : null}

              {staged.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {staged.map((entry) => (
                    <span
                      key={entry.key}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-[11px]"
                    >
                      {entry.preview ? (
                        <img src={entry.preview} alt="" className="size-6 rounded object-cover" />
                      ) : (
                        <FileText className="size-3 text-muted-foreground" />
                      )}
                      <span className="max-w-40 truncate">{entry.file.name || "pasted image"}</span>
                      <span className="text-muted-foreground">{humanBytes(entry.file.size)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.preview) URL.revokeObjectURL(entry.preview);
                          setStaged((current) => current.filter((other) => other.key !== entry.key));
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${entry.file.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="flex items-end gap-2">
                <Textarea
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  onPaste={onPaste}
                  rows={2}
                  placeholder="One card per open row, assign by the owner column…  (paste or drop files here)"
                  className="min-h-10 flex-1 text-[13px]"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="flex flex-col gap-1.5">
                  <Hint label="Attach a CSV, a document or a screenshot" side="left">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => fileInput.current?.click()}
                      aria-label="Attach files"
                      className="justify-center"
                    >
                      <Paperclip /> File
                    </Button>
                  </Hint>
                  <Button size="sm" onClick={() => void send()} loading={sending} disabled={!canSend}>
                    <Send /> Send
                  </Button>
                </div>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPTED}
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {dragOver
                  ? "Drop the files here."
                  : "⌘↵ to send. CSV, text, Markdown, JSON, images and PDFs — Word and Excel files cannot be read, so export or paste them."}
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One exchange: what was pasted on the right, what Claude made of it on the left.
 * The cards it created are chips rather than a sentence, because the useful next
 * action after reading the reply is opening one of them.
 */
function MessageBlock({
  message,
  tasksById,
  onOpenTask,
  onRemove,
}: {
  message: IntakeMessageWithFiles;
  tasksById: Map<string, Task>;
  onOpenTask: (taskId: string) => void;
  onRemove: () => void;
}) {
  const failed = message.status === "failed";
  const cancelled = message.status === "cancelled";

  return (
    <div className="space-y-1.5">
      {/* what the user sent */}
      <div className="ml-6 rounded-md rounded-br-sm border border-border/70 bg-card p-2.5">
        {message.instruction ? (
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-card-foreground">
            {message.instruction}
          </p>
        ) : (
          <p className="text-[12.5px] italic text-muted-foreground">
            Pasted without an instruction — Claude was left to read it.
          </p>
        )}

        {message.content ? (
          <details className="mt-2 rounded border border-border/60 bg-surface/60">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Table className="size-3" />
              Pasted data · {describe(message.content)}
            </summary>
            <pre className="max-h-52 overflow-auto px-2 py-1.5 font-mono text-[10.5px] leading-snug text-muted-foreground scrollbar-slim">
              {message.content}
            </pre>
          </details>
        ) : null}

        {message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}

        <p className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/80">
          <span>{relativeTime(message.createdAt)}</span>
          {message.attempts > 1 ? <span>attempt {message.attempts}</span> : null}
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
            aria-label="Remove this message and its files"
          >
            <Trash2 className="size-2.5" /> remove
          </button>
        </p>
      </div>

      {/* what came back */}
      {message.note ? (
        <div
          className={cn(
            "mr-6 rounded-md rounded-bl-sm border p-2.5",
            failed || cancelled ? "border-destructive/30 bg-destructive/6" : "border-primary/25 bg-primary/8",
          )}
        >
          <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide">
            <Sparkles className="size-2.5 text-primary" />
            <span className={failed || cancelled ? "text-destructive" : "text-primary"}>
              {cancelled ? "Cancelled" : failed ? "Could not use it" : "Claude"}
            </span>
            {message.createdTasks.length > 0 ? (
              <span className="text-muted-foreground">
                · {message.createdTasks.length} card{message.createdTasks.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-card-foreground">
            {message.note}
          </p>

          {message.createdTasks.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.createdTasks.map((taskId) => {
                const task = tasksById.get(taskId);
                return (
                  <button
                    key={taskId}
                    type="button"
                    onClick={() => onOpenTask(taskId)}
                    className="inline-flex max-w-56 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] transition-colors hover:border-ring/45 hover:bg-muted/60"
                  >
                    <span className="truncate">{task?.title ?? taskId}</span>
                    {/* A card the reply named that is no longer on the board was
                        deleted since; saying so beats a dead-looking chip. */}
                    {task ? null : <span className="text-muted-foreground">(deleted)</span>}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const KIND_ICON = { text: FileText, image: ImageIcon, pdf: FileText } as const;

function AttachmentChip({ attachment }: { attachment: IntakeAttachment }) {
  const Icon = KIND_ICON[attachment.kind];
  const url = api.attachmentUrl(attachment.id);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-surface/60 px-2 py-1 text-[11px] transition-colors hover:border-ring/45"
    >
      {attachment.kind === "image" ? (
        <img src={url} alt="" className="size-8 rounded object-cover" />
      ) : (
        <Icon className="size-3 text-muted-foreground" />
      )}
      <span className="max-w-40 truncate">{attachment.filename}</span>
      <span className="text-muted-foreground">{humanBytes(attachment.bytes)}</span>
    </a>
  );
}
