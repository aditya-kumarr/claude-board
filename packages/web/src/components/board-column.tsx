import { useState } from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { TaskCard } from "@/components/task-card";
import { cn } from "@/lib/utils";
import {
  kindColor,
  type BoardColumn,
  type BoardResponseCount,
  type ColumnKind,
  type Project,
  type Task,
  type User,
} from "@/lib/types";

export interface ColumnProps {
  column: BoardColumn;
  tasks: Task[];
  users: User[];
  now: number;
  /** Open `@claude` requests per task id, for the card badge. */
  mentionCounts: Map<string, number>;
  /** Draft replies waiting per card, so a card can say it owes somebody an answer. */
  responseCounts: Map<string, BoardResponseCount>;
  /**
   * Only cards pointed somewhere *other* than their board's project, keyed by id.
   * A board-wide project is a property of the board and belongs in its header;
   * repeating it on forty cards would say nothing and hide the ones that differ.
   */
  projectOverrides: Map<string, Project>;
  draggingTaskId: string | null;
  /** Index the dragged card would land at, or null when this column is not the drop target. */
  dropIndex: number | null;
  onTaskDragStart: (taskId: string) => void;
  onTaskDragEnd: () => void;
  onDragOverColumn: (columnId: string, index: number) => void;
  onDropOnColumn: (columnId: string, index: number) => void;
  onDragLeaveColumn: (columnId: string) => void;
  onOpenTask: (taskId: string) => void;
  onAddTask: (columnId: string) => void;
  onRenameColumn: (column: BoardColumn) => void;
  onDeleteColumn: (column: BoardColumn) => void;
}

/**
 * One state column. Drop targeting is computed from the pointer's position
 * relative to each card's midpoint, so a card can be inserted anywhere in the
 * list rather than only appended.
 */
export function BoardColumnView({
  column,
  tasks,
  users,
  now,
  mentionCounts,
  responseCounts,
  projectOverrides,
  draggingTaskId,
  dropIndex,
  onTaskDragStart,
  onTaskDragEnd,
  onDragOverColumn,
  onDropOnColumn,
  onDragLeaveColumn,
  onOpenTask,
  onAddTask,
  onRenameColumn,
  onDeleteColumn,
}: ColumnProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const tint = kindColor(column.kind);
  const atLimit = column.wipLimit !== null && tasks.length >= column.wipLimit;
  const isDropTarget = dropIndex !== null;

  const indexFromPointer = (event: React.DragEvent<HTMLDivElement>): number => {
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-card]"));
    for (let index = 0; index < cards.length; index += 1) {
      const rect = cards[index]!.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) return index;
    }
    return cards.length;
  };

  return (
    <section
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-lg border bg-surface/60 transition-colors duration-150",
        isDropTarget ? "border-ring/60 bg-accent/30" : "border-border/70",
      )}
      aria-label={`${column.name}, ${tasks.length} tasks`}
    >
      <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tint }} />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight" title={column.name}>
          {column.name}
        </h2>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums",
            atLimit ? "text-destructive" : "text-muted-foreground",
          )}
          style={atLimit ? { backgroundColor: "color-mix(in oklab, var(--destructive) 14%, transparent)" } : undefined}
        >
          {tasks.length}
          {column.wipLimit !== null ? `/${column.wipLimit}` : ""}
        </span>

        <Hint label={`Add a task to ${column.name}`}>
          <Button variant="ghost" size="icon-sm" onClick={() => onAddTask(column.id)} aria-label={`Add task to ${column.name}`}>
            <Plus />
          </Button>
        </Hint>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${column.name} options`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{column.key}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onRenameColumn(column)}>
              <Pencil /> Edit state
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onDeleteColumn(column)}>
              <Trash2 /> Delete state
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2 scrollbar-slim"
        onDragOver={(event) => {
          if (!draggingTaskId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDragOverColumn(column.id, indexFromPointer(event));
        }}
        onDragLeave={(event) => {
          // Ignore the leave events fired while crossing child cards.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onDragLeaveColumn(column.id);
        }}
        onDrop={(event) => {
          if (!draggingTaskId) return;
          event.preventDefault();
          onDropOnColumn(column.id, indexFromPointer(event));
        }}
      >
        {tasks.length === 0 && !isDropTarget ? (
          <EmptyState
            title="Nothing here"
            hint={`Drag a card in, or add one to ${column.name}.`}
            className="mt-1 border-border/50 py-6"
          />
        ) : null}

        {tasks.map((task, index) => (
          <div key={task.id} data-card className="animate-[enter_180ms_cubic-bezier(0.16,1,0.3,1)]">
            {dropIndex === index ? <DropIndicator tint={tint} /> : null}
            <TaskCard
              task={task}
              columnKind={column.kind as ColumnKind}
              users={users}
              now={now}
              openMentions={mentionCounts.get(task.id) ?? 0}
              replies={responseCounts.get(task.id)}
              projectOverride={projectOverrides.get(task.id)}
              dragging={draggingTaskId === task.id}
              onOpen={() => onOpenTask(task.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", task.id);
                onTaskDragStart(task.id);
              }}
              onDragEnd={onTaskDragEnd}
            />
          </div>
        ))}

        {dropIndex !== null && dropIndex >= tasks.length ? <DropIndicator tint={tint} /> : null}
      </div>
    </section>
  );
}

const DropIndicator = ({ tint }: { tint: string }) => (
  <div className="my-1 flex items-center gap-1" aria-hidden>
    <span className="size-1.5 rounded-full" style={{ backgroundColor: tint }} />
    <span className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: tint }} />
  </div>
);
