import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import {
  RESPONSE_CHANNEL_LABELS,
  RESPONSE_STAGE_HINTS,
  RESPONSE_STAGE_LABELS,
  RESPONSE_STATUS_LABELS,
  stageColor,
  type ResponseTurn,
  type ResponseWithContext,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ResponsePanelProps {
  /** The draft being worked on, or `null` when the panel is closed. */
  response: ResponseWithContext | null;
  onClose: () => void;
  /** Re-read the card's replies after a write of ours. */
  onChanged: () => void;
  onError: (message: string) => void;
}

/**
 * One draft reply, open for work.
 *
 * The message is the hero: it takes the whole upper half, rendered as the words
 * that will actually be sent rather than as form fields, because what the user is
 * judging is how it reads. Everything else is arranged around that.
 *
 * Two ways to change it, side by side on purpose:
 *
 *   - **the chat box** — type what you want different and Claude rewrites it. That
 *     is queued, not immediate: this process cannot reach a model, so the ask is
 *     recorded and an agent run carries it out. The composer locks while one is in
 *     flight, because two rewrites of one message from the same starting text is
 *     not something the user can untangle afterwards.
 *   - **manual editing** — for when saying what you want takes longer than typing
 *     it. A hand edit is recorded in the same thread as a rewrite, so the history
 *     the user scrolls is one story about this message.
 *
 * Nothing in this panel sends anything. "Mark as sent" records that the user sent
 * it themselves, which is why Copy sits next to it.
 */
export function ResponsePanel({ response, onClose, onChanged, onError }: ResponsePanelProps) {
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  /** The revision the manual edit started from, to notice a rewrite landing under it. */
  const [baseRevision, setBaseRevision] = useState(0);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [copied, setCopied] = useState(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);

  const open = response !== null;
  const isEmail = response?.channel === "email";
  const locked = response?.status === "sent";
  const inFlight = response?.activeTurn ?? null;

  /** Every draft opens read-only, including the next one opened from the same card. */
  useEffect(() => {
    setEditing(false);
    setInstruction("");
    setShowAllTurns(false);
    setCopied(false);
    // The panel exists to change the message, so the cursor starts where a change
    // gets typed rather than making the user find the box.
    if (response) requestAnimationFrame(() => instructionRef.current?.focus());
  }, [response?.id]);

  useEffect(() => {
    if (!response || editing) return;
    setDraftBody(response.body);
    setDraftSubject(response.subject ?? "");
    setBaseRevision(response.revision);
  }, [response?.id, response?.revision, response?.body, response?.subject, editing]);

  /**
   * Turns worth showing. Cancelled ones are noise — the user cancelled them — and
   * only the last couple are on screen unless asked, so the message stays the
   * thing being read rather than its own changelog.
   */
  const turns = useMemo(
    () => (response?.turns ?? []).filter((turn) => turn.status !== "cancelled"),
    [response?.turns],
  );
  const shownTurns = showAllTurns ? turns : turns.slice(-2);

  /** A rewrite landed while the manual editor was open, so a save would clobber it. */
  const stale = editing && response !== null && response.revision !== baseRevision;

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!response || !draftBody.trim()) return;
    await act(
      () =>
        api.updateResponse(response.id, {
          body: draftBody,
          ...(isEmail ? { subject: draftSubject.trim() || null } : {}),
        }),
      "Could not save the message",
    );
    setEditing(false);
  };

  const send = async () => {
    if (!response || !instruction.trim() || inFlight) return;
    const text = instruction.trim();
    setInstruction("");
    await act(() => api.reviseResponse(response.id, text), "Could not ask for that change");
  };

  const copy = async () => {
    if (!response) return;
    const text = isEmail && response.subject ? `${response.subject}\n\n${response.body}` : response.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onError("Could not copy — your browser blocked clipboard access");
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="gap-0 p-0" aria-describedby={undefined}>
        {response ? (
          <>
            {/* ---- who and what ---- */}
            <header className="shrink-0 space-y-2 border-b border-border/70 px-5 pb-3.5 pt-4 pr-12">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tint={isEmail ? "var(--kind-active)" : "var(--primary)"}>
                  {isEmail ? <Mail /> : <MessageSquare />}
                  {RESPONSE_CHANNEL_LABELS[response.channel]}
                </Badge>
                {/* Wrapped, because `Hint` attaches a ref to its child and `Badge`
                    is a plain function component. */}
                <Hint label={RESPONSE_STAGE_HINTS[response.stage]}>
                  <span className="inline-flex">
                    <Badge tint={stageColor(response.stage)}>{RESPONSE_STAGE_LABELS[response.stage]}</Badge>
                  </span>
                </Hint>
                {response.dueNow && response.status !== "sent" ? (
                  <Badge tint="var(--prio-high)">ready for you</Badge>
                ) : null}
                {response.status !== "draft" ? (
                  <Badge tint={response.status === "sent" ? "var(--kind-done)" : "var(--muted-foreground)"}>
                    {RESPONSE_STATUS_LABELS[response.status]}
                  </Badge>
                ) : null}
              </div>

              <SheetTitle className="text-[15px] font-semibold leading-snug">
                To {response.recipientName}
                {response.recipientRef ? (
                  <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                    {response.recipientRef}
                  </span>
                ) : null}
              </SheetTitle>
              <SheetDescription className="text-[12px]">
                {RESPONSE_STAGE_HINTS[response.stage]} Nothing here sends it — you do.
              </SheetDescription>
            </header>

            {/* ---- the message ---- */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-slim">
              {stale ? (
                <p
                  className="mb-3 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12.5px]"
                  style={{
                    borderColor: "color-mix(in oklab, var(--prio-high) 35%, transparent)",
                    backgroundColor: "color-mix(in oklab, var(--prio-high) 8%, transparent)",
                  }}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: "var(--prio-high)" }} />
                  <span>
                    Claude rewrote this while you were editing. Saving replaces its version with yours — cancel
                    instead to keep the rewrite.
                  </span>
                </p>
              ) : null}

              {isEmail ? (
                <div className="mb-3">
                  <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                    Subject
                  </p>
                  {editing ? (
                    <Input
                      value={draftSubject}
                      onChange={(event) => setDraftSubject(event.target.value)}
                      placeholder="Re: …"
                      aria-label="Subject"
                    />
                  ) : (
                    <p className="text-[13.5px] font-medium text-card-foreground">{response.subject}</p>
                  )}
                  {response.cc.length > 0 ? (
                    <p className="mt-1.5 text-[11.5px] text-muted-foreground">cc {response.cc.join(", ")}</p>
                  ) : null}
                </div>
              ) : null}

              {editing ? (
                <Textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  className="min-h-72 font-sans text-[13.5px] leading-[1.75]"
                  aria-label="Message"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void saveEdit();
                    }
                  }}
                />
              ) : (
                /* Rendered as the message rather than as a field: its line breaks are
                   part of it, so they are kept exactly. */
                <p className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-surface/50 p-3.5 text-[13.5px] leading-[1.75] text-card-foreground">
                  {response.body}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {editing ? (
                  <>
                    <Button size="sm" onClick={() => void saveEdit()} loading={busy} disabled={!draftBody.trim()}>
                      <Check /> Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                      <X /> Cancel
                    </Button>
                    <span className="text-[11px] text-muted-foreground">⌘↵ to save</span>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={locked}>
                      <Pencil /> Edit manually
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void copy()}>
                      {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
                    </Button>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      v{response.revision} · updated {relativeTime(response.updatedAt)}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* ---- what to do with it ---- */}
            <div className="shrink-0 border-t border-border/70 px-5 py-2.5">
              {response.status === "sent" ? (
                <p className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--kind-done)" }}>
                  <Check className="size-3.5" />
                  You marked this sent {relativeTime(response.sentAt ?? response.updatedAt)}.
                  <button
                    type="button"
                    onClick={() => void act(() => api.deleteResponse(response.id), "Could not remove the draft")}
                    className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Remove from the card
                  </button>
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {response.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void act(() => api.setResponseStatus(response.id, "approved"), "Could not update")}
                      disabled={busy}
                    >
                      <Check /> Looks right
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void act(() => api.setResponseStatus(response.id, "draft"), "Could not update")}
                      disabled={busy}
                    >
                      <Undo2 /> Back to draft
                    </Button>
                  )}
                  {/* Says what it does, because it does not send anything. */}
                  <Hint label="Records that you sent it. The board cannot send mail or post to Teams.">
                    <Button
                      size="sm"
                      onClick={() => void act(() => api.setResponseStatus(response.id, "sent"), "Could not update")}
                      disabled={busy}
                    >
                      <Send /> I've sent this
                    </Button>
                  </Hint>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      void act(() => api.setResponseStatus(response.id, "discarded"), "Could not discard")
                    }
                    disabled={busy}
                  >
                    <Trash2 /> Discard
                  </Button>
                </div>
              )}
            </div>

            {/* ---- the chat ---- */}
            <div className="shrink-0 border-t border-border/70 bg-surface/40 px-5 pb-4 pt-3">
              {turns.length > shownTurns.length ? (
                <button
                  type="button"
                  onClick={() => setShowAllTurns(true)}
                  className="mb-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="size-3" /> {turns.length - shownTurns.length} earlier change
                  {turns.length - shownTurns.length > 1 ? "s" : ""}
                </button>
              ) : null}

              {shownTurns.length > 0 ? (
                <div className="mb-2.5 max-h-44 space-y-2 overflow-y-auto pr-1 scrollbar-slim">
                  {shownTurns.map((turn) => (
                    <TurnRow key={turn.id} turn={turn} />
                  ))}
                </div>
              ) : null}

              {inFlight ? (
                <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/8 px-2.5 py-2 text-[12.5px]">
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-primary">
                      {inFlight.status === "pending" ? "Queued for Claude" : "Claude is rewriting it"}
                    </p>
                    <p className="text-muted-foreground">“{inFlight.instruction}”</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void act(() => api.cancelRevision(response.id), "Could not cancel that")}
                    className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-end gap-2">
                    <Textarea
                      ref={instructionRef}
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value)}
                      placeholder={
                        isEmail
                          ? "Shorter. Push the date to Friday. Drop the last paragraph…"
                          : "Make it friendlier. Say I'll come back this afternoon…"
                      }
                      rows={2}
                      className="min-h-10 flex-1 text-[13px]"
                      disabled={locked || editing}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={() => void send()}
                      loading={busy}
                      disabled={!instruction.trim() || locked || editing}
                    >
                      <Sparkles /> Rewrite
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {editing
                      ? "Save or cancel your edit first."
                      : locked
                        ? "This reply is marked sent, so there is nothing left to change."
                        : "↵ to send, ⇧↵ for a new line. Claude rewrites the whole message and changes nothing you did not ask about."}
                  </p>
                </>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * One exchange. The instruction and the answer are stacked rather than sided as
 * chat bubbles: at this width a two-column conversation costs half the reading
 * space and the thread is short by design.
 */
function TurnRow({ turn }: { turn: ResponseTurn }) {
  const failed = turn.status === "failed";
  const byHand = turn.kind === "edit";
  return (
    <div
      className="rounded-md border px-2.5 py-1.5 text-[12.5px] leading-relaxed"
      style={{
        borderColor: failed ? "color-mix(in oklab, var(--destructive) 35%, transparent)" : undefined,
        backgroundColor: failed ? "color-mix(in oklab, var(--destructive) 7%, transparent)" : undefined,
      }}
    >
      <div className="flex items-center gap-1.5">
        {byHand ? (
          <Pencil className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <Sparkles className="size-3 shrink-0 text-primary" />
        )}
        <span className={cn("min-w-0 flex-1 truncate", byHand ? "text-muted-foreground italic" : "font-medium")}>
          {turn.instruction}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="size-2.5" />
          {relativeTime(turn.createdAt)}
        </span>
      </div>
      {turn.note ? (
        <p className={cn("mt-1 pl-4.5", failed ? "text-destructive" : "text-muted-foreground")}>{turn.note}</p>
      ) : null}
    </div>
  );
}
