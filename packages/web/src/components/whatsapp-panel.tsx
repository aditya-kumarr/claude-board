import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileArchive, Image as ImageIcon, Loader2, MessageCircle, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { BoardDetail, Task, WhatsAppChat, WhatsAppImport } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Kept in step with the server's default cap, so a refusal happens before the upload. */
const MAX_BYTES = 256 * 1024 * 1024;
const DETECT = "__detect__";

const humanBytes = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export interface WhatsAppPanelProps {
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
 * A board's WhatsApp chats: upload the phone's "Export chat" zip, get cards for
 * whatever in it is new to this board.
 *
 * Each chat carries its own watermark on this board, so the thing to do is upload
 * the whole export again next time — only what came after the last successful
 * read is sent to Claude. The chat list at the top says how far that is, because
 * "what will this upload actually read" is the question to answer before pressing
 * it. Photos are only looked at when the box is ticked; nothing else ever is.
 */
export function WhatsAppPanel({ board, open, onOpenChange, revisionKey, onChanged, onOpenTask, onError }: WhatsAppPanelProps) {
  const [chats, setChats] = useState<WhatsAppChat[]>([]);
  const [imports, setImports] = useState<WhatsAppImport[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [chat, setChat] = useState<string>(DETECT);
  const [selfName, setSelfName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [readPhotos, setReadPhotos] = useState(false);
  const [since, setSince] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const boardId = board?.board.id ?? null;
  const tasksById = useMemo(() => new Map((board?.tasks ?? []).map((task) => [task.id, task])), [board?.tasks]);
  const chosenChat = chats.find((entry) => entry.id === chat) ?? null;

  const reload = useCallback(async () => {
    if (!boardId) return;
    try {
      const result = await api.whatsapp(boardId);
      setChats(result.chats);
      setImports(result.imports);
    } catch {
      // A failed read must not blank what is being read; the poll retries.
    }
  }, [boardId]);

  useEffect(() => {
    if (!open || !boardId) return;
    void reload();
  }, [open, boardId, reload, revisionKey]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [imports.length, open]);

  // The name the user goes by is per chat, so switching chats switches it.
  useEffect(() => {
    setSelfName(chosenChat?.selfName ?? "");
  }, [chosenChat?.id, chosenChat?.selfName]);

  const pick = (incoming: FileList | File[] | null | undefined) => {
    const next = incoming ? [...incoming][0] : undefined;
    if (!next) return;
    const lower = next.name.toLowerCase();
    if (!lower.endsWith(".zip") && !lower.endsWith(".txt")) {
      onError("Upload the .zip WhatsApp's Export chat produces (or its .txt, for an export without media).");
      return;
    }
    if (next.size > MAX_BYTES) {
      onError(`That export is ${humanBytes(next.size)}; the limit is ${humanBytes(MAX_BYTES)}. Export it "Without media".`);
      return;
    }
    setFile(next);
    setNotes([]);
  };

  const send = async () => {
    if (!boardId || !file || sending) return;
    setSending(true);
    setNotes([]);
    try {
      const result = await api.uploadWhatsApp(boardId, file, {
        instruction: instruction.trim() || undefined,
        readPhotos,
        chat: chat === DETECT ? undefined : chat,
        selfName: selfName.trim() || undefined,
        // A plain date means the start of that day where the user is.
        since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
      });
      setFile(null);
      setInstruction("");
      setSince("");
      setReadPhotos(false);
      setNotes(result.notes);
      setChat(result.chat.id);
      await reload();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not upload that");
    } finally {
      setSending(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    try {
      await fn();
      await reload();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : failure);
    }
  };

  return (
    <Sheet open={open && board !== null} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-2xl gap-0 p-0" aria-describedby={undefined}>
        <header className="shrink-0 space-y-1 border-b border-border/70 px-5 pb-3.5 pt-4 pr-12">
          <SheetTitle className="flex items-center gap-2 text-[15px] font-semibold">
            <MessageCircle className="size-4 text-primary" />
            WhatsApp chats
          </SheetTitle>
          <SheetDescription className="text-[12px]">
            Upload a chat's <span className="font-medium text-foreground">Export chat</span> zip and Claude turns what
            is new in it into cards on <span className="font-medium text-foreground">{board?.board.name}</span>. Upload
            the whole export each time — this board remembers how far it has read each chat.
          </SheetDescription>
        </header>

        {chats.length > 0 ? (
          <div className="shrink-0 space-y-1 border-b border-border/70 px-5 py-2.5">
            {chats.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 truncate font-medium">{entry.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {entry.syncedThrough ? `read through ${formatDateTime(entry.syncedThrough)}` : "not read yet"}
                  {entry.imported > 0 ? ` · ${entry.imported} card${entry.imported === 1 ? "" : "s"}` : ""}
                </span>
                {entry.lastStatus === "failed" ? (
                  <span className="inline-flex shrink-0 items-center gap-1" style={{ color: "var(--prio-high)" }} title={entry.lastDetail ?? undefined}>
                    <AlertTriangle className="size-3" /> last import failed
                  </span>
                ) : null}
                {forgetting === entry.id ? (
                  <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground">Forget this chat's history here? Cards stay.</span>
                    <button
                      type="button"
                      className="font-medium text-destructive hover:underline"
                      onClick={() => {
                        setForgetting(null);
                        if (chat === entry.id) setChat(DETECT);
                        void act(() => api.deleteWhatsAppChat(entry.boardId, entry.id), "Could not forget that chat");
                      }}
                    >
                      Forget
                    </button>
                    <button type="button" className="text-muted-foreground hover:underline" onClick={() => setForgetting(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setForgetting(entry.id)}
                    className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-destructive"
                    aria-label={`Forget ${entry.name}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {/* ---- what was uploaded, and what came of it ---- */}
        <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 scrollbar-slim">
          {imports.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-6 text-center">
              <Upload className="mx-auto size-5 text-muted-foreground/60" />
              <p className="mt-2 text-[13px] font-medium text-muted-foreground">No chats uploaded yet</p>
              <p className="mx-auto mt-1 max-w-80 text-[11.5px] text-muted-foreground/75">
                In WhatsApp, open the chat → ⋮ or the contact name → Export chat. “Attach media” keeps the photos; share
                the zip to this machine and drop it below.
              </p>
            </div>
          ) : (
            imports.map((entry) => (
              <ImportBlock
                key={entry.id}
                entry={entry}
                tasksById={tasksById}
                onOpenTask={onOpenTask}
                onCancel={() => void act(() => api.cancelWhatsAppImport(entry.id), "Could not cancel that")}
                onRemove={() => void act(() => api.deleteWhatsAppImport(entry.id), "Could not remove that")}
              />
            ))
          )}
        </div>

        {/* ---- the composer ---- */}
        <div
          className={cn("shrink-0 space-y-2 border-t border-border/70 bg-surface/40 px-5 pb-4 pt-3 transition-colors", dragOver && "bg-primary/8")}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            pick(event.dataTransfer?.files);
          }}
        >
          {notes.length > 0 ? (
            <div className="space-y-1 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-[12px] text-muted-foreground">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className={cn(
              "flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-left text-[12.5px] transition-colors hover:border-ring/45",
              file ? "border-primary/40 bg-primary/6" : "border-border/70",
            )}
          >
            <FileArchive className="size-4 shrink-0 text-muted-foreground" />
            {file ? (
              <>
                <span className="min-w-0 truncate font-medium">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{humanBytes(file.size)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFile(null);
                  }}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  aria-label="Remove the file"
                >
                  <X className="size-3.5" />
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{dragOver ? "Drop the export here." : "Choose or drop the exported .zip"}</span>
            )}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.txt,application/zip"
            className="hidden"
            onChange={(event) => {
              pick(event.target.files);
              event.target.value = "";
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <Select value={chat} onValueChange={setChat}>
              <SelectTrigger className="h-8 text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DETECT}>Chat: detect from the file</SelectItem>
                {chats.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    Continue “{entry.name}”
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={selfName}
              onChange={(event) => setSelfName(event.target.value)}
              placeholder="Your name in this chat"
              className="h-8 text-[12.5px]"
            />
          </div>

          <Textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={2}
            placeholder="Optional: only what the client asked for, one card per site issue…"
            className="min-h-10 text-[13px]"
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={readPhotos}
                onChange={(event) => setReadPhotos(event.target.checked)}
                className="size-3.5 accent-[var(--primary)]"
              />
              <ImageIcon className="size-3 text-muted-foreground" />
              Let Claude look at the photos
            </label>
            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
              From
              <Input
                type="date"
                value={since}
                onChange={(event) => setSince(event.target.value)}
                className="h-7 w-36 text-[12px]"
                title="Read from this date instead of where this board last stopped"
              />
            </label>
            <Button size="sm" className="ml-auto" onClick={() => void send()} loading={sending} disabled={!file}>
              <Upload /> Upload
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {chosenChat?.syncedThrough && !since
              ? `Only messages after ${formatDateTime(chosenChat.syncedThrough)} will be read.`
              : "A chat's first upload reads the last two weeks unless you pick a start date."}{" "}
            Videos, voice notes and documents are noted but never opened.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ImportBlock({
  entry,
  tasksById,
  onOpenTask,
  onCancel,
  onRemove,
}: {
  entry: WhatsAppImport;
  tasksById: Map<string, Task>;
  onOpenTask: (taskId: string) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const openImport = entry.status === "pending" || entry.status === "claimed";
  const failed = entry.status === "failed" || entry.status === "cancelled";

  return (
    <div className="group space-y-1.5">
      <div className="ml-6 rounded-md rounded-br-sm border border-border/70 bg-card p-2.5 text-[12.5px]">
        <p className="flex items-center gap-1.5 font-medium">
          <FileArchive className="size-3.5 text-muted-foreground" />
          {entry.chatName}
          <span className="font-normal text-muted-foreground">
            · {entry.messageCount} message{entry.messageCount === 1 ? "" : "s"}
            {entry.mediaCount > 0 ? ` · ${entry.mediaCount} file${entry.mediaCount === 1 ? "" : "s"}` : ""}
            {entry.readPhotos ? " · photos read" : ""}
          </span>
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {formatDateTime(entry.windowStart)} → {formatDateTime(entry.through)}
          {entry.since ? " (new since the last read)" : ""}
        </p>
        {entry.instruction ? <p className="mt-1.5 whitespace-pre-wrap break-words">{entry.instruction}</p> : null}
        {entry.cappedFrom ? (
          <p className="mt-1 text-[11.5px] text-muted-foreground">{entry.skippedOld} older message(s) left out on purpose.</p>
        ) : null}
        {entry.remaining > 0 ? (
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {entry.remaining} newer message(s) did not fit — upload the export again after this finishes.
          </p>
        ) : null}
        <p className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/80">
          <span>{relativeTime(entry.createdAt)}</span>
          <span className="truncate">{entry.filename}</span>
          {entry.attempts > 1 ? <span>attempt {entry.attempts}</span> : null}
          {openImport ? null : (
            <button
              type="button"
              onClick={onRemove}
              className="ml-auto inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
              aria-label="Remove this upload and its photos"
            >
              <Trash2 className="size-2.5" /> remove
            </button>
          )}
        </p>
      </div>

      {openImport ? (
        <div className="mr-6 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/8 px-2.5 py-2 text-[12.5px]">
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-primary">{entry.status === "pending" ? "Queued for Claude" : "Claude is reading the chat"}</p>
            <p className="text-muted-foreground">`bun run watch:whatsapp` is what picks this up.</p>
          </div>
          <button type="button" onClick={onCancel} className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
            Cancel
          </button>
        </div>
      ) : entry.note ? (
        <div
          className={cn(
            "mr-6 rounded-md rounded-bl-sm border p-2.5",
            failed ? "border-destructive/30 bg-destructive/6" : "border-primary/25 bg-primary/8",
          )}
        >
          <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide">
            <span className={failed ? "text-destructive" : "text-primary"}>
              {entry.status === "cancelled" ? "Cancelled" : failed ? "Not read — will be offered again" : "Claude"}
            </span>
            {entry.createdTasks.length > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · {entry.createdTasks.length} card{entry.createdTasks.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-card-foreground">{entry.note}</p>
          {entry.createdTasks.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.createdTasks.map((taskId) => {
                const task = tasksById.get(taskId);
                return (
                  <button
                    key={taskId}
                    type="button"
                    onClick={() => onOpenTask(taskId)}
                    className="inline-flex max-w-56 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] transition-colors hover:border-ring/45 hover:bg-muted/60"
                  >
                    <span className="truncate">{task?.title ?? taskId}</span>
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
