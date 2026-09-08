import { useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, Inbox, RefreshCw, Timer, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { formatDateTime, fromLocalInputValue, relativeTime, toLocalInputValue } from "@/lib/format";
import { SYNC_SOURCE_LABELS, type BoardSyncSummary, type SyncSource } from "@/lib/types";
import { cn } from "@/lib/utils";

const SOURCES: SyncSource[] = ["outlook", "teams"];

export interface SyncOptions {
  sources: SyncSource[];
  /** ISO instant to read from, or undefined to continue from each watermark. */
  since?: string;
  /** Ignore cooldowns and minimum intervals. */
  force?: boolean;
}

export interface SyncSettingsProps {
  open: boolean;
  sync: BoardSyncSummary;
  /** Board window start — the earliest point a custom start is worth offering. */
  boardStartsAt: string;
  busy: boolean;
  now: number;
  onClose: () => void;
  onSync: (options: SyncOptions) => void;
}

/** "in 4m" / "now" — a cooldown is only useful as a wait, not as a timestamp. */
function waitLabel(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h ${minutes % 60}m`;
}

/**
 * What the last run actually did, as separate claims.
 *
 * The run's own `detail` is one blob of prose written by the agent, and the facts
 * that matter — which watermarks moved, what is still mid-pass, what was rate
 * limited — live in structured state next to it. Bulleting the two together is
 * the only way to read "what happened" without cross-referencing three places.
 */
function lastRunBullets(sync: BoardSyncSummary, now: number): Array<{ tone: "ok" | "warn" | "bad" | "info"; text: string }> {
  const { lastRun, sources } = sync;
  if (!lastRun) return [{ tone: "info", text: "This board has never been synced." }];

  const out: Array<{ tone: "ok" | "warn" | "bad" | "info"; text: string }> = [];
  const scanned = new Set(lastRun.scope.map((entry) => entry.source));

  out.push({
    tone: "info",
    text:
      `Ran ${relativeTime(lastRun.finishedAt ?? lastRun.createdAt)} over ` +
      `${[...scanned].map((source) => SYNC_SOURCE_LABELS[source]).join(" and ") || "nothing"}` +
      `, reading from ${formatDateTime(lastRun.since)}.`,
  });

  out.push(
    lastRun.imported > 0
      ? { tone: "ok", text: `Created ${lastRun.imported} card${lastRun.imported === 1 ? "" : "s"}.` }
      : { tone: "info", text: "Created no cards — nothing in that window needed one." },
  );

  for (const state of sources) {
    if (!scanned.has(state.source)) {
      const skip = sync.skips.find((entry) => entry.source === state.source);
      out.push({
        tone: "warn",
        text:
          `${SYNC_SOURCE_LABELS[state.source]} was not read` +
          (skip
            ? `: ${skip.reason === "cooldown" ? "resting after a rate limit" : "read too recently"}, next ${waitLabel(skip.nextEligibleAt, now)}.`
            : "."),
      });
      continue;
    }

    if (state.progress) {
      out.push({
        tone: "warn",
        text:
          `${SYNC_SOURCE_LABELS[state.source]} is part way through a pass — ` +
          `${state.progress.scanned}${state.progress.total ? ` of ~${state.progress.total}` : ""} threads read. ` +
          `Its start stays at ${formatDateTime(state.progress.passSince)} until the pass finishes, so nothing is re-read.`,
      });
    } else if (state.lastStatus === "ok") {
      out.push({
        tone: "ok",
        text: `${SYNC_SOURCE_LABELS[state.source]} read in full — now up to date through ${formatDateTime(state.syncedThrough!)}.`,
      });
    } else if (state.lastStatus === "failed") {
      out.push({
        tone: "bad",
        text: `${SYNC_SOURCE_LABELS[state.source]} did not finish, so its start is unchanged and that window is read again next time.`,
      });
    }

    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) {
      out.push({
        tone: "bad",
        text: `${SYNC_SOURCE_LABELS[state.source]} hit a Microsoft Graph rate limit and is resting until ${formatDateTime(
          state.cooldownUntil,
        )} (${waitLabel(state.cooldownUntil, now)}).`,
      });
    }

    const capped = lastRun.scope.find((entry) => entry.source === state.source)?.cappedFrom;
    if (capped) {
      out.push({
        tone: "bad",
        text: `${SYNC_SOURCE_LABELS[state.source]} has a gap: it is unread since ${formatDateTime(
          capped,
        )}, but the connector cannot return messages that old, so that span was skipped rather than read.`,
      });
    }
  }

  // The agent's own words last, split so a two-sentence summary reads as two facts.
  for (const sentence of (lastRun.detail ?? "")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    out.push({ tone: "info", text: sentence });
  }

  return out;
}

const TONE: Record<"ok" | "warn" | "bad" | "info", string> = {
  ok: "var(--kind-done)",
  warn: "var(--kind-review)",
  bad: "var(--destructive)",
  info: "var(--muted-foreground)",
};

/**
 * Sync settings for one board: which inboxes to read, where to read from, and
 * what the last attempt actually did.
 *
 * Deliberately not persisted. These are the arguments to *this* press, because
 * the durable equivalents already exist and are better — the watermark decides
 * where a normal sync starts, and the per-source policy decides how often each
 * is read. A stored "always read Teams from the 1st" would quietly fight both.
 */
export function SyncSettings({ open, sync, boardStartsAt, busy, now, onClose, onSync }: SyncSettingsProps) {
  const [selected, setSelected] = useState<SyncSource[]>(SOURCES);
  const [useCustomStart, setUseCustomStart] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [force, setForce] = useState(false);

  // Reopening should show the board's current reality, not the last press's edits.
  useEffect(() => {
    if (!open) return;
    setSelected(SOURCES);
    setUseCustomStart(false);
    setForce(false);
    const earliest = sync.sources
      .map((state) => state.syncedThrough)
      .filter((value): value is string => value !== null)
      .sort()[0];
    setCustomStart(toLocalInputValue(earliest ?? boardStartsAt));
  }, [open, boardStartsAt]);

  const bullets = useMemo(() => lastRunBullets(sync, now), [sync, now]);
  const blockedByPolicy = sync.skips.filter((skip) => selected.includes(skip.source));
  const wouldRead = selected.filter((source) => force || !sync.skips.some((skip) => skip.source === source));
  const running = sync.activeRun !== null;

  const toggle = (source: SyncSource) =>
    setSelected((current) =>
      current.includes(source)
        ? current.length === 1
          ? current // never leave nothing selected — a sync of no sources is not a thing
          : current.filter((entry) => entry !== source)
        : [...current, source],
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold">Sync settings</DialogTitle>
          <DialogDescription>
            Applies to the next sync only. Normally each inbox continues from where it last got to.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label hint="both by default">Read from</Label>
          <div className="flex gap-2">
            {SOURCES.map((source) => {
              const on = selected.includes(source);
              const state = sync.sources.find((entry) => entry.source === source)!;
              const skip = sync.skips.find((entry) => entry.source === source);
              return (
                <Hint
                  key={source}
                  label={
                    skip
                      ? `${skip.detail} — eligible ${waitLabel(skip.nextEligibleAt, now)}`
                      : state.syncedThrough
                        ? `Up to date through ${formatDateTime(state.syncedThrough)}`
                        : "Never synced on this board"
                  }
                >
                  <button
                    type="button"
                    onClick={() => toggle(source)}
                    aria-pressed={on}
                    className={cn(
                      "flex flex-1 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                      on ? "border-primary/45 bg-primary/8" : "border-border/70 hover:bg-muted/50",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Inbox className="size-3.5" style={{ color: on ? "var(--primary)" : undefined }} />
                      {SYNC_SOURCE_LABELS[source]}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {skip ? (
                        <Timer className="size-3.5" style={{ color: TONE.warn }} />
                      ) : state.progress ? (
                        <CircleDashed className="size-3.5" style={{ color: TONE.warn }} />
                      ) : null}
                      {on ? <Check className="size-3.5" style={{ color: "var(--primary)" }} /> : null}
                    </span>
                  </button>
                </Hint>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label hint="leave off to continue where each inbox stopped">Start from</Label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setUseCustomStart(false)}
              aria-pressed={!useCustomStart}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors",
                !useCustomStart ? "border-primary/45 bg-primary/8 font-medium" : "border-border/70 hover:bg-muted/50",
              )}
            >
              Continue from last sync
            </button>
            <button
              type="button"
              onClick={() => setUseCustomStart(true)}
              aria-pressed={useCustomStart}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors",
                useCustomStart ? "border-primary/45 bg-primary/8 font-medium" : "border-border/70 hover:bg-muted/50",
              )}
            >
              Pick a date
            </button>
          </div>
          {useCustomStart ? (
            <>
              <Input
                type="datetime-local"
                value={customStart}
                max={toLocalInputValue(new Date(now).toISOString())}
                onChange={(event) => setCustomStart(event.target.value)}
                aria-label="Read from"
              />
              <p className="text-[11px] text-muted-foreground">
                Overrides the stored position for this run only. Re-reading is safe — a card already imported is
                recognised and skipped, not duplicated. Teams cannot return messages older than a few days
                whatever you pick here.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {sync.sources
                .map(
                  (state) =>
                    `${SYNC_SOURCE_LABELS[state.source]}: ${
                      state.progress
                        ? `resuming its pass from ${formatDateTime(state.progress.passSince)}`
                        : state.syncedThrough
                          ? formatDateTime(state.syncedThrough)
                          : "never synced"
                    }`,
                )
                .join(" · ")}
            </p>
          )}
        </div>

        {blockedByPolicy.length > 0 ? (
          <button
            type="button"
            onClick={() => setForce((current) => !current)}
            aria-pressed={force}
            className={cn(
              "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-[12px] leading-relaxed transition-colors",
              force ? "border-destructive/45 bg-destructive/8" : "border-border/70 hover:bg-muted/50",
            )}
          >
            <Zap className="mt-px size-3.5 shrink-0" style={{ color: force ? "var(--destructive)" : TONE.warn }} />
            <span>
              <span className="font-medium">
                {force ? "Ignoring the wait" : `${blockedByPolicy.map((s) => SYNC_SOURCE_LABELS[s.source]).join(" and ")} is resting`}
              </span>
              <span className="text-muted-foreground">
                {" — "}
                {blockedByPolicy
                  .map((skip) => `${SYNC_SOURCE_LABELS[skip.source]} eligible ${waitLabel(skip.nextEligibleAt, now)}`)
                  .join(", ")}
                . {force ? "It will be read anyway." : "Tap to read it anyway."}
              </span>
            </span>
          </button>
        ) : null}

        <Separator />

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">After the last sync</h3>
          <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1 text-[12.5px] leading-relaxed scrollbar-slim">
            {bullets.map((bullet, index) => (
              <li key={index} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-[6px] size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: TONE[bullet.tone] }}
                />
                <span className={bullet.tone === "info" ? "text-muted-foreground" : "text-card-foreground"}>
                  {bullet.text}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <DialogFooter>
          <p className="mr-auto text-[11px] text-muted-foreground">
            {running
              ? "A sync is already queued for this board."
              : wouldRead.length === 0
                ? "Everything selected is resting — allow the wait to be ignored, or come back later."
                : `Will read ${wouldRead.map((source) => SYNC_SOURCE_LABELS[source]).join(" and ")}.`}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={busy || running || wouldRead.length === 0}
            onClick={() =>
              onSync({
                sources: selected,
                since: useCustomStart ? (fromLocalInputValue(customStart) ?? undefined) : undefined,
                force: force || undefined,
              })
            }
          >
            <RefreshCw /> Sync now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
