import { Archive, ArrowUpRight, CalendarRange, FolderGit2, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { shortPath } from "@/components/project-select";
import { formatDateTime, relativeTime, remainingLabel } from "@/lib/format";
import { DURATION_LABELS, kindColor, type BoardDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Every archived board, with its cards still readable behind it.
 *
 * Archiving is the reversible half of getting a board out of the way — deleting
 * is the other one, and it is the only thing here that asks first. A board that
 * closed with work outstanding says so on its row, because the reason to come
 * back to an archived board is almost always the thing that never got finished.
 */
export function ArchiveView({
  boards,
  now,
  onOpen,
  onRestore,
  onDelete,
}: {
  boards: BoardDetail[];
  now: number;
  onOpen: (boardId: string) => void;
  onRestore: (detail: BoardDetail) => void;
  onDelete: (detail: BoardDetail) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <div
          className="grid size-9 place-items-center rounded-lg"
          style={{
            color: "var(--muted-foreground)",
            backgroundColor: "color-mix(in oklab, var(--muted-foreground) 15%, transparent)",
          }}
        >
          <Archive className="size-4.5" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Archive</h1>
          <p className="text-[13px] text-muted-foreground">
            Boards taken out of the sidebar. Nothing was deleted — open one to read its cards, or restore it to put it
            back.
          </p>
        </div>
        {boards.length > 0 ? <Badge variant="outline">{boards.length} archived</Badge> : null}
      </div>

      {boards.length === 0 ? (
        <EmptyState
          icon={<Archive />}
          title="Nothing archived"
          hint="Archive a board from its menu, or from the Expired group in the sidebar."
          className="py-12"
        />
      ) : (
        <ul className="space-y-1.5">
          {boards.map((detail) => {
            const { board, stats } = detail;
            const outstanding = stats.total - stats.done;
            return (
              <li
                key={board.id}
                className={cn(
                  "group flex items-center gap-3 rounded-md border border-border/70 bg-card px-3 py-2.5",
                  "transition-colors hover:border-ring/40",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onOpen(board.id)}
                      className="min-w-0 truncate text-[13px] font-medium hover:underline"
                    >
                      {board.name}
                    </button>
                    <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
                    {outstanding > 0 ? (
                      <Badge tint={kindColor("blocked")}>{outstanding} unfinished</Badge>
                    ) : stats.total > 0 ? (
                      <Badge tint={kindColor("done")}>all done</Badge>
                    ) : (
                      <Badge variant="outline">empty</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <Hint label={`${DURATION_LABELS[board.durationKind]} · closed ${formatDateTime(board.endsAt)}`}>
                      <span className="inline-flex items-center gap-1">
                        <CalendarRange className="size-3" />
                        {detail.window.label}
                      </span>
                    </Hint>
                    <span className="opacity-40">·</span>
                    {/* An archived board is usually a closed one, but archiving
                        does not wait for the deadline — say which it is. */}
                    <span>
                      {new Date(board.endsAt).getTime() < now
                        ? `closed ${relativeTime(board.endsAt, now)}`
                        : `${remainingLabel(detail.window, now)} on the clock`}
                    </span>
                    <span className="opacity-40">·</span>
                    <span className="tabular-nums">
                      {stats.done}/{stats.total} done
                    </span>
                    {detail.project ? (
                      <>
                        <span className="opacity-40">·</span>
                        <span
                          className="inline-flex max-w-40 items-center gap-1 truncate"
                          style={{ color: "var(--kind-review)" }}
                          title={detail.project.path}
                        >
                          <FolderGit2 className="size-3 shrink-0" />
                          {shortPath(detail.project.path)}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Hint label="Put it back in the sidebar">
                    <Button variant="outline" size="xs" onClick={() => onRestore(detail)}>
                      <RotateCcw /> Restore
                    </Button>
                  </Hint>
                  <Hint label="Delete the board and every card on it — not reversible">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${board.name}`}
                      onClick={() => onDelete(detail)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </Hint>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
