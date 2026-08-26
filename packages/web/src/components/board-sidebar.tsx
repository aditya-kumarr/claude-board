import { Bot, FolderGit2, LayoutGrid, Plus, Radio, ScrollText, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress, Separator } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { progressPercent, remainingLabel, urgencyColor } from "@/lib/format";
import { type BoardDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SidebarView = { kind: "board"; boardId: string } | { kind: "queue"; assignee: string } | { kind: "activity" };

export function BoardSidebar({
  boards,
  view,
  now,
  live,
  onSelect,
  onCreateBoard,
  onOpenProjects,
  projectCount,
}: {
  boards: BoardDetail[];
  view: SidebarView;
  now: number;
  /** True briefly after a change arrived from outside this tab (i.e. from Claude). */
  live: boolean;
  onSelect: (view: SidebarView) => void;
  onCreateBoard: () => void;
  /** Opens the directory register — where a card's work can be carried out. */
  onOpenProjects: () => void;
  projectCount: number;
}) {
  const claudeTotal = boards.reduce((sum, board) => sum + board.stats.assignedToClaude, 0);
  const myTotal = boards.reduce((sum, board) => sum + board.stats.assignedToMe, 0);

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
      </nav>

      <Separator />

      <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          Boards
          <span className="ml-1.5 font-normal opacity-70">{boards.length}</span>
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

        {boards.map((detail) => {
          const active = view.kind === "board" && view.boardId === detail.board.id;
          const tint = urgencyColor(detail.window, now);
          const outstanding = detail.stats.total - detail.stats.done;
          return (
            <button
              key={detail.board.id}
              onClick={() => onSelect({ kind: "board", boardId: detail.board.id })}
              className={cn(
                "w-full rounded-md border px-2.5 py-2 text-left transition-all duration-150",
                active
                  ? "border-ring/45 bg-accent/45 shadow-sm"
                  : "border-transparent hover:border-border hover:bg-muted/50",
              )}
            >
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{detail.board.name}</p>
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
          );
        })}
      </div>
    </aside>
  );
}

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
