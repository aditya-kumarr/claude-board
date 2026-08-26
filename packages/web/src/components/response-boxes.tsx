import { Loader2, Mail, MessageSquare, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Hint } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/format";
import {
  RESPONSE_STAGE_HINTS,
  RESPONSE_STAGE_LABELS,
  RESPONSE_STATUS_LABELS,
  stageColor,
  type ResponseStage,
  type ResponseWithContext,
  type TaskResponseSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const STAGE_ORDER: ResponseStage[] = ["acknowledge", "completion"];

export interface ResponseBoxesProps {
  summary: TaskResponseSummary;
  /** Whether the card came out of an inbox, which changes what "none yet" means. */
  imported: boolean;
  busy: boolean;
  onOpen: (response: ResponseWithContext) => void;
  onRequestDrafts: () => void;
  onCancelDrafts: () => void;
}

/**
 * The replies a card owes, as boxes small enough to take in at a glance.
 *
 * Grouped by stage rather than by person, because the question the user is
 * answering when they look at a card is "what do I owe right now" — and the
 * answer is the top row. The bottom row is written at the same time but not
 * wanted yet, so it is dimmed until the card reaches a done state.
 *
 * Each box shows the first line or two of the actual message. A box that only
 * said "email to Priya" would have to be opened to be worth anything, and then
 * six of them means six clicks to find the one that needs work.
 */
export function ResponseBoxes({
  summary,
  imported,
  busy,
  onOpen,
  onRequestDrafts,
  onCancelDrafts,
}: ResponseBoxesProps) {
  const live = summary.responses.filter((response) => response.status !== "discarded");
  const drafting = summary.activeDraftTurn;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Replies
          {live.length > 0 ? <span className="rounded-full bg-muted px-1.5 text-[10px]">{live.length}</span> : null}
        </h3>
        {drafting ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-primary">
            <Loader2 className="size-3 animate-spin" />
            {drafting.status === "pending" ? "queued for Claude" : "Claude is writing"}
            <button
              type="button"
              onClick={onCancelDrafts}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              cancel
            </button>
          </span>
        ) : (
          <Hint label="Claude reads the card and writes the messages you owe" side="right">
            <Button size="xs" variant="ghost" onClick={onRequestDrafts} loading={busy} className="ml-auto">
              {live.length > 0 ? <Plus /> : <Sparkles />}
              {live.length > 0 ? "Draft more" : "Draft replies"}
            </Button>
          </Hint>
        )}
      </div>

      {live.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {imported
            ? "No replies drafted for this card yet — a sync normally writes them while it still has the message. Ask Claude for them here."
            : "This card was not imported from a mail or a chat, so nobody is waiting on a reply. Draft one anyway if somebody is."}
        </p>
      ) : (
        <div className="space-y-2.5">
          {STAGE_ORDER.map((stage) => {
            const inStage = live.filter((response) => response.stage === stage);
            if (inStage.length === 0) return null;
            // A completion reply exists from the start but is not wanted until the
            // card is finished, so it is stated rather than left to be inferred.
            const waiting = stage === "completion" && !inStage.some((response) => response.dueNow);
            return (
              <div key={stage} className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: stageColor(stage) }} />
                  <span style={{ color: stageColor(stage) }}>{RESPONSE_STAGE_LABELS[stage]}</span>
                  <span className="font-normal normal-case tracking-normal text-muted-foreground">
                    {waiting ? "— waiting until this card is done" : RESPONSE_STAGE_HINTS[stage]}
                  </span>
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {inStage.map((response) => (
                    <ResponseBox key={response.id} response={response} dimmed={waiting} onOpen={onOpen} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ResponseBox({
  response,
  dimmed,
  onOpen,
}: {
  response: ResponseWithContext;
  dimmed: boolean;
  onOpen: (response: ResponseWithContext) => void;
}) {
  const isEmail = response.channel === "email";
  const tint = stageColor(response.stage);
  const sent = response.status === "sent";

  return (
    <button
      type="button"
      onClick={() => onOpen(response)}
      className={cn(
        "group relative overflow-hidden rounded-md border border-border/80 bg-card p-2.5 pl-3 text-left",
        "transition-all duration-150 hover:-translate-y-px hover:border-ring/45",
        "hover:shadow-[0_6px_16px_-8px_rgba(0,0,0,0.35)]",
        dimmed && "opacity-65 hover:opacity-100",
        sent && "opacity-70 hover:opacity-100",
      )}
      aria-label={`Open the ${response.stage} reply to ${response.recipientName}`}
    >
      {/* Stage rail, matching the priority rail on a task card. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px] transition-[width] group-hover:w-1"
        style={{ backgroundColor: tint }}
      />

      <div className="flex items-center gap-1.5">
        {isEmail ? (
          <Mail className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <MessageSquare className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-card-foreground">
          {response.recipientName}
        </span>
        {response.activeTurn ? (
          <Hint label={`Claude is on it: “${response.activeTurn.instruction}”`}>
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          </Hint>
        ) : response.status === "approved" ? (
          <Badge tint={tint} className="shrink-0 px-1.5 py-0 text-[9.5px]">
            ready
          </Badge>
        ) : sent ? (
          <Badge tint="var(--kind-done)" className="shrink-0 px-1.5 py-0 text-[9.5px]">
            {RESPONSE_STATUS_LABELS.sent}
          </Badge>
        ) : null}
      </div>

      {isEmail && response.subject ? (
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{response.subject}</p>
      ) : null}

      {/* The words themselves: a box that had to be opened to be useful would not
          be worth putting on the card. */}
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-snug text-muted-foreground">
        {response.body}
      </p>

      <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/80">
        {response.revision > 1 ? <span>v{response.revision}</span> : null}
        <span>{relativeTime(response.updatedAt)}</span>
        <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">open →</span>
      </p>
    </button>
  );
}
