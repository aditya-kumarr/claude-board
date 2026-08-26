import { AlertTriangle, AtSign, Ban, CalendarClock, Check, Loader2, MessageSquare, Reply } from "lucide-react";
import { Avatar } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { formatDue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { priorityColor, type BoardResponseCount, type ColumnKind, type Task, type User } from "@/lib/types";

const ASSIGNEE_TINT: Record<string, string> = { me: "var(--kind-active)", claude: "var(--primary)" };

export interface TaskCardProps {
  task: Task;
  columnKind: ColumnKind;
  users: User[];
  now: number;
  /** Unresolved `@claude` requests in this card's thread. */
  openMentions?: number;
  /** Draft replies held against this card, and how many are the user's to send. */
  replies?: BoardResponseCount;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

/**
 * A card carries the four things that decide whether you act on it — priority,
 * owner, deadline, and whether it is stuck — without needing to be opened. The
 * left rail is priority-coloured so a column scans by urgency at a glance.
 */
export function TaskCard({
  task,
  columnKind,
  users,
  now,
  openMentions = 0,
  replies,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: TaskCardProps) {
  const assignee = users.find((user) => user.id === task.assigneeId);
  const overdue = columnKind !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() < now;
  const dueSoon =
    !overdue && columnKind !== "done" && task.dueAt !== null && new Date(task.dueAt).getTime() - now < 24 * 3_600_000;
  const done = columnKind === "done";

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${task.title} — ${task.priority} priority`}
      className={cn(
        "group relative cursor-grab overflow-hidden rounded-md border border-border/80 bg-card p-2.5 pl-3 text-left",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-150",
        "hover:-translate-y-px hover:border-ring/45 hover:shadow-[0_6px_16px_-8px_rgba(0,0,0,0.35)]",
        "active:cursor-grabbing",
        dragging && "opacity-40 rotate-[0.6deg] scale-[0.99]",
        done && "opacity-70 hover:opacity-100",
      )}
    >
      {/* Priority rail */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-md transition-[width] group-hover:w-1"
        style={{ backgroundColor: priorityColor(task.priority) }}
      />

      <div className="flex items-start gap-2">
        <p
          className={cn(
            "min-w-0 flex-1 text-[13px] font-medium leading-snug text-card-foreground",
            done && "line-through decoration-muted-foreground/60",
          )}
        >
          {task.title}
        </p>
        {assignee ? (
          <Avatar name={assignee.displayName} tint={ASSIGNEE_TINT[assignee.id]} size="sm" />
        ) : (
          <Hint label="Unassigned">
            <span className="mt-0.5 size-5 shrink-0 rounded-full border border-dashed border-border" />
          </Hint>
        )}
      </div>

      {task.description ? (
        <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{task.description}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground">
        <span
          className="font-medium uppercase tracking-wide"
          style={{ color: priorityColor(task.priority) }}
        >
          {task.priority}
        </span>

        {/* An unanswered ask outranks the rest of this row: somebody is waiting. */}
        {openMentions > 0 ? (
          <Hint label={`${openMentions} @claude request${openMentions > 1 ? "s" : ""} waiting for a reply`}>
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-px font-medium ring-1 ring-inset"
              style={{
                color: "var(--primary)",
                backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
                // @ts-expect-error CSS custom property for the ring color
                "--tw-ring-color": "color-mix(in oklab, var(--primary) 30%, transparent)",
              }}
            >
              <AtSign className="size-2.5" />
              {openMentions > 1 ? `${openMentions} asks` : "asked"}
            </span>
          </Hint>
        ) : null}

        {/* A drafted reply is the other half of a card that came out of somebody's
            inbox: the chip says one is waiting so it can be found without opening
            every card, and highlights only when it is the user's to send. */}
        {replies && replies.open > 0 ? (
          <Hint
            label={
              replies.working
                ? "Claude is rewriting one of this card's draft replies"
                : replies.dueNow > 0
                  ? `${replies.dueNow} draft repl${replies.dueNow > 1 ? "ies" : "y"} ready for you to send`
                  : `${replies.open} draft repl${replies.open > 1 ? "ies" : "y"}, for when this card is done`
            }
          >
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-px ring-1 ring-inset",
                replies.dueNow > 0 && "font-medium",
              )}
              style={{
                color: replies.dueNow > 0 ? "var(--kind-active)" : "var(--muted-foreground)",
                backgroundColor:
                  replies.dueNow > 0 ? "color-mix(in oklab, var(--kind-active) 12%, transparent)" : "transparent",
                // @ts-expect-error CSS custom property for the ring color
                "--tw-ring-color": `color-mix(in oklab, ${
                  replies.dueNow > 0 ? "var(--kind-active)" : "var(--border)"
                } 30%, transparent)`,
              }}
            >
              {replies.working ? <Loader2 className="size-2.5 animate-spin" /> : <Reply className="size-2.5" />}
              {replies.dueNow > 0 ? `${replies.dueNow} to send` : replies.open}
            </span>
          </Hint>
        ) : null}

        {task.dueAt ? (
          <span
            className={cn("inline-flex items-center gap-1", overdue && "font-semibold text-destructive")}
            style={dueSoon ? { color: "var(--kind-review)" } : undefined}
          >
            {overdue ? <AlertTriangle className="size-3" /> : <CalendarClock className="size-3" />}
            {overdue ? "overdue" : formatDue(task.dueAt, now)}
          </span>
        ) : null}

        {task.blockedReason ? (
          <Hint label={task.blockedReason}>
            <span className="inline-flex max-w-32 items-center gap-1 truncate" style={{ color: "var(--kind-blocked)" }}>
              <Ban className="size-3 shrink-0" />
              {task.blockedReason}
            </span>
          </Hint>
        ) : null}

        {done && task.completedAt ? (
          <span className="inline-flex items-center gap-1" style={{ color: "var(--kind-done)" }}>
            <Check className="size-3" /> done
          </span>
        ) : null}

        <span className="ml-auto font-mono text-[9.5px] opacity-0 transition-opacity group-hover:opacity-50">
          {task.id}
        </span>
      </div>
    </article>
  );
}

export { MessageSquare };
