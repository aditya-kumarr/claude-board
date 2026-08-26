import { useMemo } from "react";
import { AlertTriangle, Check, Inbox, Loader2, RefreshCw, Terminal, X } from "lucide-react";
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

    const lines = sources.map(
      (state) =>
        `${SYNC_SOURCE_LABELS[state.source]}: ${
          state.syncedThrough ? `read through ${relativeTime(state.syncedThrough)}` : "never synced"
        }`,
    );
    if (lastRun?.status === "failed") lines.push(`Last run failed — ${lastRun.detail ?? "no reason recorded"}`);
    else if (lastRun?.status === "ok") {
      lines.push(
        `Last run ${relativeTime(lastRun.finishedAt ?? lastRun.createdAt)}: ${
          lastRun.imported > 0 ? `${lastRun.imported} task(s) imported` : "nothing new"
        }`,
      );
    }
    lines.push("Reads only what arrived since the last successful sync.");
    return lines.join("\n");
  }, [activeRun, lastRun, sources]);

  const failed = !running && lastRun?.status === "failed";
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

  if (activeRun || !lastRun || lastRun.status === "cancelled") return null;

  const ok = lastRun.status === "ok";
  return (
    <p
      className="flex items-start gap-1.5 px-4 pb-2 text-[11.5px] leading-relaxed sm:px-6"
      style={{ color: ok ? "var(--muted-foreground)" : "var(--destructive)" }}
    >
      {ok ? (
        <Check className="mt-px size-3 shrink-0" style={{ color: "var(--kind-done)" }} />
      ) : (
        <AlertTriangle className="mt-px size-3 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="font-medium">
          {ok ? (lastRun.imported > 0 ? `Imported ${lastRun.imported}` : "Nothing new") : "Sync failed"}
        </span>
        {lastRun.detail ? <span> · {lastRun.detail}</span> : null}
        <span className="text-muted-foreground"> · {relativeTime(lastRun.finishedAt ?? lastRun.createdAt)}</span>
      </span>
    </p>
  );
}
