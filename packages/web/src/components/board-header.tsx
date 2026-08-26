import { AlertTriangle, Archive, AtSign, CalendarRange, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress, Separator } from "@/components/ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { SyncButton, SyncResult } from "@/components/sync-button";
import { formatDateTime, progressPercent, remainingLabel, urgencyColor } from "@/lib/format";
import { DURATION_LABELS, kindColor, type BoardDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The header's job is to make the board's deadline impossible to miss: the bar
 * shows how much of the window has burned, coloured by urgency, next to what is
 * still outstanding.
 */
export function BoardHeader({
  detail,
  now,
  onAddTask,
  onAddColumn,
  onArchive,
  onDelete,
  onSync,
  onCancelSync,
  syncing,
}: {
  detail: BoardDetail;
  now: number;
  onAddTask: () => void;
  onAddColumn: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSync: () => void;
  onCancelSync: () => void;
  /** True while the queue request itself is in flight. */
  syncing: boolean;
}) {
  const { board, window: boardWindow, stats } = detail;
  const percent = progressPercent(boardWindow, now);
  const tint = urgencyColor(boardWindow, now);
  const expired = new Date(board.endsAt).getTime() < now;
  const outstanding = stats.total - stats.done;

  return (
    <header className="shrink-0 border-b border-border/70 bg-background/85 px-5 py-3.5 backdrop-blur">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight">{board.name}</h1>
            {board.archived ? <Badge variant="outline">archived</Badge> : null}
            {expired ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle /> window closed
              </Badge>
            ) : null}
          </div>
          {board.description ? (
            <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">{board.description}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <SyncButton
            sync={detail.sync}
            disabled={board.archived}
            pressing={syncing}
            now={now}
            onSync={onSync}
            onCancel={onCancelSync}
          />
          <Button size="sm" onClick={onAddTask}>
            <Plus /> New task
          </Button>
          <Button variant="outline" size="sm" onClick={onAddColumn}>
            <Plus /> State
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Board options">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{board.id}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={onArchive}>
                <Archive /> {board.archived ? "Unarchive board" : "Archive board"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 /> Delete board
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Hint label={`${DURATION_LABELS[board.durationKind]} · closes ${formatDateTime(board.endsAt)}`}>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CalendarRange className="size-3.5" />
            {boardWindow.label}
          </span>
        </Hint>

        <div className="flex min-w-40 flex-1 items-center gap-2">
          <Progress value={percent} indicatorColor={tint} className="h-1.5 flex-1" />
          <span className="shrink-0 text-xs font-semibold tabular-nums" style={{ color: tint }}>
            {remainingLabel(boardWindow, now)}
          </span>
        </div>

        <Separator orientation="vertical" className="hidden h-4 sm:block" />

        <div className="flex flex-wrap items-center gap-1.5">
          <Stat label="left" value={outstanding} tint={outstanding === 0 ? kindColor("done") : undefined} />
          <Stat label="done" value={stats.done} tint={kindColor("done")} />
          {stats.blocked > 0 ? <Stat label="blocked" value={stats.blocked} tint={kindColor("blocked")} /> : null}
          {stats.review > 0 ? <Stat label="in review" value={stats.review} tint={kindColor("review")} /> : null}
          {stats.overdue > 0 ? <Stat label="overdue" value={stats.overdue} tint="var(--destructive)" /> : null}
          {/* Sits with the counts rather than the assignee badges: it is work
              waiting on Claude regardless of who the cards are assigned to. */}
          {stats.openMentions > 0 ? (
            <Hint label={`${stats.openMentions} @claude request(s) on this board still unanswered`}>
              <Badge tint="var(--primary)" className="gap-1">
                <AtSign /> {stats.openMentions} asked
              </Badge>
            </Hint>
          ) : null}
          <Badge tint="var(--primary)" className="gap-1">
            Claude {stats.assignedToClaude}
          </Badge>
          <Badge tint={kindColor("active")} className="gap-1">
            You {stats.assignedToMe}
          </Badge>
        </div>
      </div>

      <SyncResult sync={detail.sync} now={now} />
    </header>
  );
}

const Stat = ({ label, value, tint }: { label: string; value: number; tint?: string }) => (
  <span
    className={cn("inline-flex items-baseline gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[11px]")}
    style={tint ? { color: tint, backgroundColor: `color-mix(in oklab, ${tint} 13%, transparent)` } : undefined}
  >
    <span className="font-semibold tabular-nums">{value}</span>
    <span className="opacity-75">{label}</span>
  </span>
);
