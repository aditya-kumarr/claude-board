import { useMemo } from "react";
import { AlertTriangle, Check, CircleDashed, Inbox, Loader2, RefreshCw, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/format";
import { SYNC_SOURCE_LABELS, type BoardSyncSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How long a request may sit unclaimed before the UI stops implying progress and
 * says nothing is listening. Comfortably above a watcher's poll interval, so a
 * normal queue-then-claim never trips it.
 */
const STALE_AFTER_MS = 20_000;

/**
 * Per-source watermarks mean a run can half-succeed: Outlook read in full while
 * a throttled Teams scan is left to re-read. The run's own status is `failed` in
 * that case — correctly, since the window was not finished — but showing it as a
 * flat failure hides cards that did land and reads as "nothing happened".
 */
function outcome(sync: BoardSyncSummary): "ok" | "partial" | "failed" | null {
  const run = sync.lastRun;
  if (!run || run.status === "cancelled") return null;
  // A source part way through a batched pass outranks the run's own status: the
  // run succeeded at the batch it was given, and there is simply more to read.
  if (sync.sources.some((state) => state.progress)) return "partial";
  if (run.status === "ok") return "ok";
  // Partial needs something actually left over to name. Without this guard a run
  // whose sources all read ok rendered as "Imported 0,  unfinished".
  const incomplete = sync.sources.filter((state) => state.lastStatus === "failed");
  if (incomplete.length === 0) return run.imported > 0 ? "ok" : "failed";
  const banked = run.imported > 0 || sync.sources.some((state) => state.lastStatus === "ok");
  return banked ? "partial" : "failed";
}

/** "Teams 10 of ~47 chats" — what is left of a pass, for the result line. */
function passLabel(sync: BoardSyncSummary): string | null {
  const mid = sync.sources.filter((state) => state.progress);
  if (mid.length === 0) return null;
  return mid
    .map(
      (state) =>
        `${SYNC_SOURCE_LABELS[state.source]} ${state.progress!.scanned}` +
        `${state.progress!.total ? ` of ~${state.progress!.total}` : ""} chats`,
    )
    .join(", ");
}

export interface SyncButtonProps {
  sync: BoardSyncSummary;
  disabled?: boolean;
  pressing: boolean;
  now: number;
  onSync: () => void;
  onCancel: () => void;
}

/**
 * Pulls pending work out of Outlook and Teams onto this board.
 *
 * The button queues a request rather than doing the work — the API has no
 * Microsoft Graph credentials, so an agent run performs the read. That makes the
 * honest label "queued", not "syncing", until something claims it; a button that
 * claims to be working when nothing is running is worse than a slow one.
 *
 * The tooltip carries the watermark, because "when did this last look at my mail"
 * is the only question anyone actually asks of a Sync button.
 */
export function SyncButton({ sync, disabled, pressing, now, onSync, onCancel }: SyncButtonProps) {
  const { activeRun, lastRun, sources } = sync;
  const running = activeRun !== null;
  // Queued and unclaimed is a different situation from actually running, and the
  // difference matters: one is progress, the other needs the user to start a
  // runner. Only the second offers a way out.
  const queued = activeRun?.status === "pending";
  const stale = queued && now - new Date(activeRun.createdAt).getTime() > STALE_AFTER_MS;

  const tooltip = useMemo(() => {
    if (activeRun) {
      const scope = activeRun.scope.map((entry) => SYNC_SOURCE_LABELS[entry.source]).join(" + ");
      return activeRun.status === "pending"
        ? `${scope} sync queued ${relativeTime(activeRun.createdAt)} — waiting for Claude to pick it up. Run \`bun run watch:sync\` if nothing is listening.`
        : `${scope} sync in progress, started ${relativeTime(activeRun.startedAt ?? activeRun.createdAt)}.`;
    }

    const lines = sources.map((state) => {
      const read = state.syncedThrough ? `read through ${relativeTime(state.syncedThrough)}` : "never synced";
      // A resting source is the difference between "Teams found nothing" and
      // "Teams was not looked at", which is the whole reason to say it here.
      const rest =
        state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now
          ? ` — resting after a rate limit, back ${relativeTime(state.cooldownUntil)}`
          : "";
      return `${SYNC_SOURCE_LABELS[state.source]}: ${read}${rest}`;
    });
    if (lastRun) {
      const when = relativeTime(lastRun.finishedAt ?? lastRun.createdAt);
      const incomplete = sources.filter((state) => state.lastStatus === "failed").map((state) => SYNC_SOURCE_LABELS[state.source]);
      const pass = passLabel(sync);
      if (pass) {
        lines.push(`Pass in progress: ${pass} read. Press Sync to continue it — nothing is re-read.`);
      } else if (lastRun.status === "ok") {
        lines.push(`Last run ${when}: ${lastRun.imported > 0 ? `${lastRun.imported} task(s) imported` : "nothing new"}`);
      } else if (lastRun.status === "failed") {
        lines.push(
          lastRun.imported > 0 || incomplete.length < sources.length
            ? `Last run ${when} was partial: ${lastRun.imported} imported, ${incomplete.join(" and ")} not finished`
            : `Last run failed ${when} — ${lastRun.detail ?? "no reason recorded"}`,
        );
      }
    }
    lines.push(
      "Reads only what arrived since the last successful sync. Teams is scanned on a slower cadence than",
      "mail — one Teams scan costs about fifty Microsoft Graph calls, so pressing this repeatedly would",
      "only earn a rate limit.",
    );
    return lines.join("\n");
  }, [activeRun, lastRun, sources, now]);

  const result = outcome(sync);
  // Only a run that achieved nothing marks the button itself as a problem.
  const failed = !running && result === "failed";
  const neverSynced = !running && sources.every((state) => state.syncedThrough === null);

  return (
    <div className="flex items-center gap-1">
      <Hint label={tooltip}>
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={disabled || running || pressing}
          aria-label={running ? "Sync queued" : "Sync from Outlook and Teams"}
          className={cn(
            "gap-1.5",
            failed && "border-destructive/45 text-destructive hover:bg-destructive/10",
            stale && "border-dashed",
          )}
        >
          {!running ? (
            failed ? (
              <AlertTriangle />
            ) : neverSynced ? (
              <Inbox />
            ) : (
              <RefreshCw />
            )
          ) : stale ? (
            // A spinner here would claim progress that is not happening.
            <Terminal />
          ) : (
            <Loader2 className="animate-spin" />
          )}
          {running ? (queued ? "Queued" : "Syncing") : "Sync"}
        </Button>
      </Hint>

      {/* Without this a queued run nobody claims leaves the board with the button
          disabled and no way back. */}
      {queued ? (
        <Hint label="Cancel this queued sync" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            disabled={pressing}
            aria-label="Cancel queued sync"
            className="size-7 text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
          </Button>
        </Hint>
      ) : null}
    </div>
  );
}

/**
 * Result line for a finished run, shown under the header so an import is not a
 * silent event — a sync that found nothing has to look different from one that
 * did not happen.
 */
export function SyncResult({ sync, now }: { sync: BoardSyncSummary; now: number }) {
  const { activeRun, lastRun } = sync;
  const result = outcome(sync);

  // A tooltip nobody hovers is not an explanation. If a request has been sitting
  // unclaimed, say so in the open, and say exactly what to run.
  if (activeRun?.status === "pending" && now - new Date(activeRun.createdAt).getTime() > STALE_AFTER_MS) {
    return (
      <p className="flex items-start gap-1.5 px-4 pb-2 text-[11.5px] leading-relaxed text-muted-foreground sm:px-6">
        <Terminal className="mt-px size-3 shrink-0" style={{ color: "var(--kind-review)" }} />
        <span className="min-w-0">
          <span className="font-medium text-foreground">Queued {relativeTime(activeRun.createdAt)}, nothing has picked it up.</span>{" "}
          The board cannot read your mail itself — run{" "}
          <code className="rounded bg-muted px-1 py-px font-mono text-[10.5px]">bun run watch:sync</code>, or ask
          Claude to run it in a session. Cancel it with the × if you would rather not.
        </span>
      </p>
    );
  }

  if (activeRun || !lastRun || result === null) return null;

  const incomplete = sync.sources
    .filter((state) => state.lastStatus === "failed")
    .map((state) => SYNC_SOURCE_LABELS[state.source]);

  const tone =
    result === "ok" ? "var(--muted-foreground)" : result === "partial" ? "var(--kind-review)" : "var(--destructive)";
  const pass = passLabel(sync);
  const headline =
    result === "failed"
      ? "Sync failed"
      : result === "partial"
        ? pass
          ? `Imported ${lastRun.imported} — read ${pass} so far`
          : `Imported ${lastRun.imported}, ${incomplete.join(" and ")} unfinished`
        : lastRun.imported > 0
          ? `Imported ${lastRun.imported}`
          : "Nothing new";

  return (
    <p className="flex items-start gap-1.5 px-4 pb-2 text-[11.5px] leading-relaxed sm:px-6" style={{ color: tone }}>
      {result === "ok" ? (
        <Check className="mt-px size-3 shrink-0" style={{ color: "var(--kind-done)" }} />
      ) : result === "partial" ? (
        <CircleDashed className="mt-px size-3 shrink-0" />
      ) : (
        <AlertTriangle className="mt-px size-3 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="font-medium">{headline}</span>
        {result === "partial" ? (
          <span className="text-muted-foreground">
            {pass
              ? " — the newest threads are in; press Sync to keep going through the rest."
              : " — press Sync again to finish the rest; nothing was lost."}
          </span>
        ) : null}
        {lastRun.detail ? <span className="text-muted-foreground"> · {lastRun.detail}</span> : null}
        <span className="text-muted-foreground"> · {relativeTime(lastRun.finishedAt ?? lastRun.createdAt)}</span>
      </span>
    </p>
  );
}
