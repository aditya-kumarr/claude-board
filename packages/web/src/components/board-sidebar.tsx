import { Archive, Bot, FolderGit2, LayoutGrid, Plus, Radio, ScrollText, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress, Separator } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { progressPercent, remainingLabel, urgencyColor } from "@/lib/format";
import { type BoardDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SidebarView =
  | { kind: "board"; boardId: string }
  | { kind: "queue"; assignee: string }
  | { kind: "activity" }
  | { kind: "archive" };

export function BoardSidebar({
  boards,
  view,
  now,
  live,
  onSelect,
  onCreateBoard,
  onArchiveBoard,
  onOpenProjects,
  projectCount,
  archivedCount,
}: {
  /** Live boards only — archived ones live on their own page. */
  boards: BoardDetail[];
  view: SidebarView;
  now: number;
  /** True briefly after a change arrived from outside this tab (i.e. from Claude). */
  live: boolean;
  onSelect: (view: SidebarView) => void;
  onCreateBoard: () => void;
  /** Clears a board out of this list without deleting it; it lands in the archive. */
  onArchiveBoard: (detail: BoardDetail) => void;
  /** Opens the directory register — where a card's work can be carried out. */
  onOpenProjects: () => void;
  projectCount: number;
  archivedCount: number;
}) {
  const claudeTotal = boards.reduce((sum, board) => sum + board.stats.assignedToClaude, 0);
  const myTotal = boards.reduce((sum, board) => sum + board.stats.assignedToMe, 0);

  /**
   * A board whose deadline has passed drops out of the running list into its own
   * group rather than disappearing: its cards are still the record of what did
   * not get finished. Nothing is written to say so — expiry is the board's own
   * `endsAt` against the clock, so a board that has its window extended comes
   * straight back up here.
   */
  const running: BoardDetail[] = [];
  const expired: BoardDetail[] = [];
  for (const detail of boards) {
    (new Date(detail.board.endsAt).getTime() < now ? expired : running).push(detail);
  }
  expired.sort((a, b) => new Date(b.board.endsAt).getTime() - new Date(a.board.endsAt).getTime());

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border/70 bg-surface/50">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <div className="grid size-7 place-items-center rounded-md bg-primary/15 text-primary">
          <LayoutGrid className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight">Board</p>
          <p className="text-[10.5px] text-muted-foreground">time-boxed kanban</p>
        </div>
        <Hint label={live ? "Just synced a change from Claude" : "Watching for changes from Claude"}>
          <span
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-full transition-colors",
              live ? "text-primary" : "text-muted-foreground/50",
            )}
          >
            <Radio className={cn("size-3.5", live && "animate-pulse")} />
          </span>
        </Hint>
      </div>

      <Separator />

      <nav className="space-y-0.5 p-2">
        <NavRow
          icon={<Bot />}
          label="Claude's queue"
          count={claudeTotal}
          active={view.kind === "queue" && view.assignee === "claude"}
          tint="var(--primary)"
          onClick={() => onSelect({ kind: "queue", assignee: "claude" })}
        />
        <NavRow
          icon={<User />}
          label="My tasks"
          count={myTotal}
          active={view.kind === "queue" && view.assignee === "me"}
          tint="var(--kind-active)"
          onClick={() => onSelect({ kind: "queue", assignee: "me" })}
        />
        <NavRow
          icon={<ScrollText />}
          label="Activity"
          active={view.kind === "activity"}
          onClick={() => onSelect({ kind: "activity" })}
        />
        {/* Not a view — a register. It sits with the navigation because a project
            is the answer to "where does the work happen", which is board-wide. */}
        <NavRow
          icon={<FolderGit2 />}
          label="Projects"
          count={projectCount}
          active={false}
          tint="var(--kind-review)"
          onClick={onOpenProjects}
        />
        <NavRow
          icon={<Archive />}
          label="Archive"
          count={archivedCount}
          active={view.kind === "archive"}
          onClick={() => onSelect({ kind: "archive" })}
        />
      </nav>

      <Separator />

      <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Boards
          <span className="ml-1.5 font-normal opacity-70">{running.length}</span>
        </p>
        <Hint label="New board">
          <Button variant="ghost" size="icon-sm" onClick={onCreateBoard} aria-label="New board">
            <Plus />
          </Button>
        </Hint>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3 scrollbar-slim">
        {boards.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No boards yet. Create one, or ask Claude to make it for you.
          </p>
        ) : null}

        {running.length === 0 && expired.length > 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Every board's window has closed. Start a new one, or reopen one below.
          </p>
        ) : null}

        {running.map((detail) => (
          <BoardRow
            key={detail.board.id}
            detail={detail}
            now={now}
            active={view.kind === "board" && view.boardId === detail.board.id}
            onSelect={() => onSelect({ kind: "board", boardId: detail.board.id })}
          />
        ))}

        {expired.length > 0 ? (
          <>
            <div className="flex items-center gap-2 px-2.5 pb-1 pt-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Expired
                <span className="ml-1.5 font-normal opacity-70">{expired.length}</span>
              </p>
              <span className="h-px flex-1 bg-border/70" />
            </div>
            {expired.map((detail) => (
              <BoardRow
                key={detail.board.id}
                detail={detail}
                now={now}
                active={view.kind === "board" && view.boardId === detail.board.id}
                onSelect={() => onSelect({ kind: "board", boardId: detail.board.id })}
                onArchive={() => onArchiveBoard(detail)}
              />
            ))}
          </>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * One board in the sidebar. `onArchive` is passed only for an expired board —
 * the row's own way out of the list, so clearing a closed board does not mean
 * opening it first to find the menu. Archiving is reversible, which is why it is
 * one click with no confirm.
 */
const BoardRow = ({
  detail,
  now,
  active,
  onSelect,
  onArchive,
}: {
  detail: BoardDetail;
  now: number;
  active: boolean;
  onSelect: () => void;
  onArchive?: () => void;
}) => {
  const tint = urgencyColor(detail.window, now);
  const outstanding = detail.stats.total - detail.stats.done;
  return (
    <div className="group relative">
      <button
        onClick={onSelect}
        className={cn(
          "w-full rounded-md border px-2.5 py-2 text-left transition-all duration-150",
          active
            ? "border-ring/45 bg-accent/45 shadow-sm"
            : "border-transparent hover:border-border hover:bg-muted/50",
          onArchive && "opacity-80 hover:opacity-100",
        )}
      >
        <div className="flex items-center gap-2">
          <p className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", onArchive && "pr-6")}>
            {detail.board.name}
          </p>
          {detail.stats.overdue > 0 ? (
            <span className="shrink-0 rounded-full bg-destructive/15 px-1.5 text-[10px] font-semibold text-destructive">
              {detail.stats.overdue}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{detail.window.label}</span>
          <span className="shrink-0 font-medium tabular-nums" style={{ color: tint }}>
            {remainingLabel(detail.window, now)}
          </span>
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <Progress value={progressPercent(detail.window, now)} indicatorColor={tint} className="h-1" />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {outstanding === 0 && detail.stats.total > 0 ? "clear" : `${outstanding} left`}
          </span>
        </div>
      </button>
      {onArchive ? (
        <Hint label="Move to the archive — nothing is deleted, and it can be restored">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Archive ${detail.board.name}`}
            onClick={onArchive}
            className="absolute right-1 top-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Archive />
          </Button>
        </Hint>
      ) : null}
    </div>
  );
};

const NavRow = ({
  icon,
  label,
  count,
  active,
  tint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  tint?: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={cn(
      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
      "[&_svg]:size-4 [&_svg]:shrink-0",
      active ? "bg-accent/50 font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
    )}
  >
    <span style={active && tint ? { color: tint } : undefined}>{icon}</span>
    <span className="flex-1 text-left">{label}</span>
    {count !== undefined && count > 0 ? (
      <span
        className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
        style={{
          color: tint ?? "var(--muted-foreground)",
          backgroundColor: `color-mix(in oklab, ${tint ?? "var(--muted-foreground)"} 16%, transparent)`,
        }}
      >
        {count}
      </span>
    ) : null}
  </button>
);
