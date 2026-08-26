import { useEffect, useState } from "react";
import { AlertTriangle, Bot, FolderGit2, Inbox, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { formatDue, relativeTime } from "@/lib/format";
import { kindColor, priorityColor, type ActivityEntry, type TaskWithContext } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Cross-board work list for one assignee — the mirror of the MCP `my_queue` tool. */
export function QueueView({
  assignee,
  revisionKey,
  now,
  onOpenTask,
}: {
  assignee: string;
  revisionKey: unknown;
  now: number;
  onOpenTask: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskWithContext[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .listTasks({ assignee, includeDone: false })
      .then(({ tasks: list }) => !cancelled && setTasks(list))
      .catch(() => !cancelled && setTasks([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [assignee, revisionKey]);

  const isAgent = assignee === "claude";
  const overdue = tasks.filter((task) => task.overdue).length;

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <div
          className="grid size-9 place-items-center rounded-lg"
          style={{
            color: isAgent ? "var(--primary)" : "var(--kind-active)",
            backgroundColor: `color-mix(in oklab, ${isAgent ? "var(--primary)" : "var(--kind-active)"} 15%, transparent)`,
          }}
        >
          {isAgent ? <Bot className="size-4.5" /> : <UserIcon className="size-4.5" />}
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{isAgent ? "Claude's queue" : "My tasks"}</h1>
          <p className="text-[13px] text-muted-foreground">
            {isAgent
              ? "Everything assigned to Claude across every board — this is what it reads from my_queue."
              : "Everything assigned to you, most urgent first."}
          </p>
        </div>
        {overdue > 0 ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle /> {overdue} overdue
          </Badge>
        ) : null}
      </div>

      {loading ? null : tasks.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="Nothing queued"
          hint={isAgent ? "Assign a task to Claude and it shows up here." : "You are clear for now."}
          className="py-12"
        />
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                onClick={() => onOpenTask(task.id)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md border border-border/70 bg-card px-3 py-2.5 text-left",
                  "transition-all hover:-translate-y-px hover:border-ring/40 hover:shadow-[0_6px_16px_-10px_rgba(0,0,0,0.4)]",
                )}
              >
                <span
                  aria-hidden
                  className="h-8 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: priorityColor(task.priority) }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{task.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="truncate">{task.boardName}</span>
                    <span className="opacity-40">·</span>
                    <span style={{ color: kindColor(task.columnKind) }}>{task.columnName}</span>
                    {/* This list crosses boards, so which codebase a card is in is
                        not implied by anything else on the row. */}
                    {task.project ? (
                      <>
                        <span className="opacity-40">·</span>
                        <span
                          className="inline-flex max-w-40 items-center gap-1 truncate"
                          style={{ color: "var(--kind-review)" }}
                          title={task.project.path}
                        >
                          <FolderGit2 className="size-3 shrink-0" />
                          {task.project.name}
                        </span>
                      </>
                    ) : null}
                    {task.blockedReason ? (
                      <>
                        <span className="opacity-40">·</span>
                        <span className="truncate" style={{ color: kindColor("blocked") }}>
                          {task.blockedReason}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-[11px] font-medium tabular-nums",
                    task.overdue ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {task.overdue ? "overdue" : formatDue(task.dueAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTION_TINT: Record<string, string> = {
  "task.created": "var(--kind-active)",
  "task.moved": "var(--primary)",
  "task.deleted": "var(--destructive)",
  "task.commented": "var(--kind-review)",
  "board.created": "var(--kind-done)",
  "board.deleted": "var(--destructive)",
  "column.added": "var(--kind-review)",
  "column.deleted": "var(--destructive)",
};

/** Merged audit trail across boards, showing whether a change came from the UI or from Claude. */
export function ActivityView({ boardIds, revisionKey }: { boardIds: string[]; revisionKey: unknown }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(boardIds.map((boardId) => api.boardActivity(boardId, 40).catch(() => ({ activity: [] }))))
      .then((results) => {
        if (cancelled) return;
        const merged = results
          .flatMap((result) => result.activity)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 120);
        setEntries(merged);
      })
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [boardIds.join(","), revisionKey]);

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
      <p className="mb-4 text-[13px] text-muted-foreground">
        Every change, and whether it came from this UI or from Claude over MCP.
      </p>

      {entries.length === 0 ? (
        <EmptyState title="Nothing has happened yet" className="py-12" />
      ) : (
        <ol className="relative space-y-0 border-l border-border/70 pl-4">
          {entries.map((entry) => {
            const tint = ACTION_TINT[entry.action] ?? "var(--muted-foreground)";
            const title = (entry.detail?.title ?? entry.detail?.name ?? null) as string | null;
            return (
              <li key={`${entry.id}-${entry.createdAt}`} className="relative py-1.5">
                <span
                  aria-hidden
                  className="absolute -left-[21px] top-3 size-2 rounded-full ring-2 ring-background"
                  style={{ backgroundColor: tint }}
                />
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                  <span className="font-medium">{entry.actorId === "claude" ? "Claude" : entry.actorId === "me" ? "You" : entry.actorId}</span>
                  <span className="font-mono text-[11px]" style={{ color: tint }}>
                    {entry.action}
                  </span>
                  {title ? <span className="truncate text-muted-foreground">{title}</span> : null}
                  {entry.detail?.from && entry.detail?.to ? (
                    <span className="text-muted-foreground">
                      {String(entry.detail.from)} → {String(entry.detail.to)}
                    </span>
                  ) : null}
                  <Badge variant="outline" className="ml-auto shrink-0 py-0 text-[9.5px] uppercase">
                    {entry.source}
                  </Badge>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">{relativeTime(entry.createdAt)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
