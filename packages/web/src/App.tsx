import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { LayoutGrid, ServerCrash } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { BoardSidebar, type SidebarView } from "@/components/board-sidebar";
import { BoardHeader } from "@/components/board-header";
import { BoardColumnView } from "@/components/board-column";
import { TaskDialog } from "@/components/task-dialog";
import { IntakePanel } from "@/components/intake-panel";
import { CreateBoardDialog } from "@/components/create-board-dialog";
import { CreateTaskDialog } from "@/components/create-task-dialog";
import { ProjectsDialog } from "@/components/projects-dialog";
import { BoardProjectDialog } from "@/components/board-project-dialog";
import { ColumnDialog } from "@/components/column-dialog";
import { ActivityView, QueueView } from "@/components/queue-view";
import { ArchiveView } from "@/components/archive-view";
import { useBoards, useNow } from "@/hooks/use-boards";
import { api, ApiError } from "@/lib/api";
import { SYNC_SOURCE_LABELS, type BoardColumn, type BoardDetail, type Project } from "@/lib/types";

const VIEW_STORAGE_KEY = "automation.view";

export default function App() {
  const { boards, archivedBoards, allBoards, users, projects, loading, error, refresh, remoteChangeAt } = useBoards();
  const now = useNow(30_000);

  const [view, setView] = useState<SidebarView>(() => {
    try {
      const stored = localStorage.getItem(VIEW_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as SidebarView) : { kind: "queue", assignee: "claude" };
    } catch {
      return { kind: "queue", assignee: "claude" };
    }
  });

  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [boardDialogOpen, setBoardDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskDialogColumn, setTaskDialogColumn] = useState<string | null>(null);
  const [columnDialogOpen, setColumnDialogOpen] = useState(false);
  const [projectsDialogOpen, setProjectsDialogOpen] = useState(false);
  const [boardProjectOpen, setBoardProjectOpen] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<BoardColumn | null>(null);

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
    // A chat belongs to one board; leaving it open across a switch would show the
    // previous board's conversation over the new board's cards.
    setIntakeOpen(false);
  }, [view]);

  // Fall back to a sensible view when the selected board disappears. Checked
  // against every board rather than the sidebar's: an archived board is still
  // openable from the archive, so it is deletion — not archiving — that should
  // bounce the view.
  useEffect(() => {
    if (view.kind !== "board" || loading) return;
    if (!allBoards.some((detail) => detail.board.id === view.boardId)) {
      setView(boards[0] ? { kind: "board", boardId: boards[0].board.id } : { kind: "queue", assignee: "claude" });
    }
  }, [allBoards, boards, view, loading]);

  const activeBoard = useMemo(
    () => (view.kind === "board" ? allBoards.find((detail) => detail.board.id === view.boardId) ?? null : null),
    [allBoards, view],
  );

  /**
   * Open `@claude` requests per card. Derived once here rather than fetched per
   * card: the board payload already carries them, and a badge that needs its own
   * request per card is a badge that will not be there.
   */
  const mentionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const mention of activeBoard?.openMentions ?? []) {
      counts.set(mention.taskId, (counts.get(mention.taskId) ?? 0) + 1);
    }
    return counts;
  }, [activeBoard?.openMentions]);

  /**
   * Draft replies per card, from the board payload for the same reason
   * `mentionCounts` is: a badge that costs a request per card is a badge that
   * will not be there.
   */
  const responseCounts = useMemo(
    () => new Map((activeBoard?.responses ?? []).map((entry) => [entry.taskId, entry])),
    [activeBoard?.responses],
  );

  /**
   * Only the cards pointed somewhere other than their board's project. Derived
   * here for the same reason the two maps above are — and filtered to overrides
   * because the board's own project is already in the header, so repeating it on
   * every card would bury the handful that actually differ.
   */
  const projectOverrides = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const overrides = new Map<string, Project>();
    for (const task of activeBoard?.tasks ?? []) {
      if (!task.projectId || task.projectId === activeBoard?.board.projectId) continue;
      const project = byId.get(task.projectId);
      if (project) overrides.set(task.id, project);
    }
    return overrides;
  }, [activeBoard?.tasks, activeBoard?.board.projectId, projects]);

  const fail = useCallback((message: string) => toast.error(message), []);

  const [syncing, setSyncing] = useState(false);

  /**
   * Queues a sync. The API cannot reach Outlook or Teams itself, so success here
   * means "asked", not "done" — the toast says so rather than implying the mail
   * has already been read. The result arrives via the revision poll when an agent
   * run finishes it.
   */
  const cancelSync = useCallback(async () => {
    if (!activeBoard) return;
    setSyncing(true);
    try {
      await api.cancelSync(activeBoard.board.id);
      toast.success("Sync cancelled", { description: "Nothing was read, so the watermark is unchanged." });
      await refresh();
    } catch (error) {
      fail(error instanceof ApiError ? error.message : "Could not cancel the sync");
    } finally {
      setSyncing(false);
    }
  }, [activeBoard, refresh, fail]);

  const syncBoard = useCallback(async () => {
    if (!activeBoard) return;
    setSyncing(true);
    try {
      const { run, alreadyQueued, skipped } = await api.requestSync(activeBoard.board.id);
      const scope = run.scope.map((entry) => entry.source).join(" + ");
      // A source left out is worth a sentence. Teams is read on a slower cadence
      // than mail because one Teams scan costs ~50 Microsoft Graph calls, so a
      // press that reads only Outlook is normal — but silence about it reads as
      // Teams having been checked and found empty.
      const held = skipped.map((entry) => SYNC_SOURCE_LABELS[entry.source]).join(" and ");
      toast.success(alreadyQueued ? "Already queued" : `Sync queued for ${scope}`, {
        description: alreadyQueued
          ? "A sync for this board is already waiting to run."
          : held
            ? `Reading ${scope} since the last sync. ${held} was read recently and is resting — ${
                skipped[0]!.reason === "cooldown" ? "it hit a rate limit" : "it is scanned less often than mail"
              }, so this press leaves it alone.`
            : "Claude reads your Outlook and Teams since the last sync and adds what is still outstanding.",
      });
      await refresh();
    } catch (error) {
      fail(error instanceof ApiError ? error.message : "Could not queue the sync");
    } finally {
      setSyncing(false);
    }
  }, [activeBoard, refresh, fail]);

  const drop = useCallback(
    async (columnId: string, index: number) => {
      const taskId = draggingTaskId;
      setDraggingTaskId(null);
      setDropTarget(null);
      if (!taskId) return;
      try {
        // force: dragging is an explicit human decision, so a WIP limit warns rather than blocks.
        await api.moveTask(taskId, { column: columnId, index, force: true });
        await refresh();
      } catch (cause) {
        fail(cause instanceof ApiError ? cause.message : "Could not move that task");
      }
    },
    [draggingTaskId, refresh, fail],
  );

  const removeColumn = useCallback(
    async (column: BoardColumn) => {
      if (!activeBoard) return;
      const count = activeBoard.tasks.filter((task) => task.columnId === column.id).length;
      const message =
        count > 0
          ? `Delete "${column.name}"? Its ${count} task(s) move to the leftmost remaining state.`
          : `Delete "${column.name}"?`;
      if (!window.confirm(message)) return;
      try {
        const result = await api.deleteColumn(activeBoard.board.id, column.id);
        await refresh();
        toast.success(result.movedTasks > 0 ? `State deleted, ${result.movedTasks} task(s) moved` : "State deleted");
      } catch (cause) {
        fail(cause instanceof ApiError ? cause.message : "Could not delete that state");
      }
    },
    [activeBoard, refresh, fail],
  );

  /**
   * Takes the board it acts on rather than reading the selected one: the same
   * action is reachable from the board menu, an expired row in the sidebar and
   * the archive page, and only the first of those is looking at the open board.
   */
  const setBoardArchived = useCallback(
    async (detail: BoardDetail, archived: boolean) => {
      try {
        await api.updateBoard(detail.board.id, { archived });
        await refresh();
        toast.success(archived ? "Board archived" : "Board restored", {
          description: archived ? "Nothing was deleted — it is under Archive." : undefined,
        });
      } catch (cause) {
        fail(cause instanceof ApiError ? cause.message : `Could not ${archived ? "archive" : "restore"} the board`);
      }
    },
    [refresh, fail],
  );

  const removeBoard = useCallback(
    async (detail: BoardDetail) => {
      if (!window.confirm(`Delete "${detail.board.name}" and all ${detail.stats.total} of its tasks?`)) return;
      try {
        await api.deleteBoard(detail.board.id);
        setView((current) =>
          current.kind === "board" && current.boardId === detail.board.id
            ? { kind: "queue", assignee: "claude" }
            : current,
        );
        await refresh();
        toast.success("Board deleted");
      } catch (cause) {
        fail(cause instanceof ApiError ? cause.message : "Could not delete the board");
      }
    },
    [refresh, fail],
  );

  const live = remoteChangeAt !== null && Date.now() - remoteChangeAt < 6000;

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <BoardSidebar
          boards={boards}
          view={view}
          now={now}
          live={live}
          onSelect={setView}
          onCreateBoard={() => setBoardDialogOpen(true)}
          onArchiveBoard={(detail) => void setBoardArchived(detail, true)}
          onOpenProjects={() => setProjectsDialogOpen(true)}
          projectCount={projects.length}
          archivedCount={archivedBoards.length}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {error ? (
            <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-5 py-2.5 text-[13px]">
              <ServerCrash className="size-4 shrink-0 text-destructive" />
              <span className="flex-1">{error}</span>
              <Button variant="outline" size="xs" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-8 w-64" />
              <div className="flex gap-3">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-72 w-72" />
                ))}
              </div>
            </div>
          ) : view.kind === "queue" ? (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
              <QueueView
                assignee={view.assignee}
                revisionKey={boards.map((b) => b.board.updatedAt).join() + remoteChangeAt}
                now={now}
                onOpenTask={setOpenTaskId}
              />
            </div>
          ) : view.kind === "activity" ? (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
              <ActivityView
                boardIds={boards.map((detail) => detail.board.id)}
                revisionKey={remoteChangeAt ?? boards.length}
              />
            </div>
          ) : view.kind === "archive" ? (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
              <ArchiveView
                boards={archivedBoards}
                now={now}
                onOpen={(boardId) => setView({ kind: "board", boardId })}
                onRestore={(detail) => void setBoardArchived(detail, false)}
                onDelete={(detail) => void removeBoard(detail)}
              />
            </div>
          ) : activeBoard ? (
            <>
              <BoardHeader
                detail={activeBoard}
                now={now}
                onAddTask={() => {
                  setTaskDialogColumn(null);
                  setTaskDialogOpen(true);
                }}
                onAddColumn={() => {
                  setEditingColumn(null);
                  setColumnDialogOpen(true);
                }}
                onArchive={() => void setBoardArchived(activeBoard, !activeBoard.board.archived)}
                onDelete={() => void removeBoard(activeBoard)}
                onSync={() => void syncBoard()}
                onCancelSync={() => void cancelSync()}
                onOpenIntake={() => setIntakeOpen(true)}
                onSetProject={() => setBoardProjectOpen(true)}
                syncing={syncing}
              />

              <div
                className="grain flex min-h-0 flex-1 gap-3 overflow-x-auto p-4 scrollbar-slim"
                onDragEnd={() => {
                  setDraggingTaskId(null);
                  setDropTarget(null);
                }}
              >
                {activeBoard.columns.map((column) => (
                  <BoardColumnView
                    key={column.id}
                    column={column}
                    tasks={activeBoard.tasks
                      .filter((task) => task.columnId === column.id)
                      .sort((a, b) => a.position - b.position)}
                    users={users}
                    now={now}
                    canAddTasks={!activeBoard.board.archived}
                    mentionCounts={mentionCounts}
                    responseCounts={responseCounts}
                    projectOverrides={projectOverrides}
                    draggingTaskId={draggingTaskId}
                    dropIndex={dropTarget?.columnId === column.id ? dropTarget.index : null}
                    onTaskDragStart={setDraggingTaskId}
                    onTaskDragEnd={() => {
                      setDraggingTaskId(null);
                      setDropTarget(null);
                    }}
                    onDragOverColumn={(columnId, index) => setDropTarget({ columnId, index })}
                    onDragLeaveColumn={(columnId) =>
                      setDropTarget((current) => (current?.columnId === columnId ? null : current))
                    }
                    onDropOnColumn={(columnId, index) => void drop(columnId, index)}
                    onOpenTask={setOpenTaskId}
                    onAddTask={(columnId) => {
                      setTaskDialogColumn(columnId);
                      setTaskDialogOpen(true);
                    }}
                    onRenameColumn={(column) => {
                      setEditingColumn(column);
                      setColumnDialogOpen(true);
                    }}
                    onDeleteColumn={(column) => void removeColumn(column)}
                  />
                ))}

                <button
                  onClick={() => {
                    setEditingColumn(null);
                    setColumnDialogOpen(true);
                  }}
                  className="h-fit w-44 shrink-0 rounded-lg border border-dashed border-border/70 px-3 py-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:border-ring/40 hover:bg-muted/40 hover:text-foreground"
                >
                  + Add a state
                </button>
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <EmptyState
                icon={<LayoutGrid />}
                title="No board selected"
                hint="Create a time-boxed board, or pick one from the left."
                action={
                  <Button size="sm" className="mt-1" onClick={() => setBoardDialogOpen(true)}>
                    New board
                  </Button>
                }
              />
            </div>
          )}
        </main>
      </div>

      <IntakePanel
        board={activeBoard}
        open={intakeOpen}
        onOpenChange={setIntakeOpen}
        revisionKey={remoteChangeAt}
        onChanged={() => void refresh()}
        onOpenTask={(taskId) => {
          // Leave the chat open behind the card: the reply that named it is the
          // context for reading it, and closing it would lose the thread.
          setOpenTaskId(taskId);
        }}
        onError={fail}
      />

      <TaskDialog
        taskId={openTaskId}
        boards={allBoards}
        users={users}
        projects={projects}
        revisionKey={remoteChangeAt}
        onClose={() => setOpenTaskId(null)}
        onChanged={() => void refresh()}
        onError={fail}
      />

      <CreateBoardDialog
        projects={projects}
        open={boardDialogOpen}
        onOpenChange={setBoardDialogOpen}
        onCreated={(boardId) => {
          void refresh();
          setView({ kind: "board", boardId });
          toast.success("Board created");
        }}
      />

      <CreateTaskDialog
        board={activeBoard}
        users={users}
        projects={projects}
        defaultColumnId={taskDialogColumn}
        open={taskDialogOpen}
        onOpenChange={setTaskDialogOpen}
        onCreated={() => {
          void refresh();
          toast.success("Task added");
        }}
      />

      <ProjectsDialog
        projects={projects}
        open={projectsDialogOpen}
        onOpenChange={setProjectsDialogOpen}
        onChanged={() => void refresh()}
      />

      <BoardProjectDialog
        board={activeBoard}
        projects={projects}
        open={boardProjectOpen}
        onOpenChange={setBoardProjectOpen}
        onSaved={() => {
          void refresh();
          toast.success("Board project set");
        }}
        onManageProjects={() => setProjectsDialogOpen(true)}
      />

      <ColumnDialog
        board={activeBoard}
        column={editingColumn}
        open={columnDialogOpen}
        onOpenChange={setColumnDialogOpen}
        onSaved={() => {
          void refresh();
          toast.success(editingColumn ? "State updated" : "State added");
        }}
      />

      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
