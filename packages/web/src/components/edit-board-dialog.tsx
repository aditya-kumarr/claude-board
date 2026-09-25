import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProjectSelect } from "@/components/project-select";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, previewBoardEnd, toLocalInputValue } from "@/lib/format";
import { DURATION_LABELS, type BoardDetail, type DurationKind, type Project } from "@/lib/types";

const KINDS: DurationKind[] = ["day", "week", "month", "quarter", "year", "custom"];

/**
 * Renames a board, moves its deadline, and re-points its project.
 *
 * The window is the part that needs care, because a board's end is a deadline
 * every card on it is bound by. Keeping the same period kind keeps the board's
 * own window (a "week" board stays the week it was made for); switching kind
 * re-derives it from today; a custom board takes the date picked here. The dialog
 * previews the resulting end and says, before saving, how many cards are due
 * after it — the server pulls those in to the new end, and a deadline moving
 * without being told is the one surprise here worth preventing.
 *
 * Only what changed is sent, so renaming a board never touches its window, and
 * moving only the end keeps the start where it was.
 */
export function EditBoardDialog({
  board,
  projects,
  open,
  onOpenChange,
  onSaved,
}: {
  board: BoardDetail | null;
  projects: Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [durationKind, setDurationKind] = useState<DurationKind>("week");
  const [endDate, setEndDate] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = board?.board ?? null;
  const originalEndDate = current ? toLocalInputValue(current.endsAt).slice(0, 10) : "";

  // Reset to the board as it is each time the dialog opens.
  useEffect(() => {
    if (!open || !current) return;
    setName(current.name);
    setDescription(current.description ?? "");
    setDurationKind(current.durationKind);
    setEndDate(originalEndDate);
    setProjectId(current.projectId);
    setError(null);
  }, [open, current?.id]);

  const kindChanged = current !== null && durationKind !== current.durationKind;
  const dateChanged = durationKind === "custom" && endDate !== originalEndDate;
  const windowChanged = kindChanged || dateChanged;

  /** The end this save would produce. Unchanged window: the board's own end. */
  const newEnd = useMemo<Date | null>(() => {
    if (!current) return null;
    if (!windowChanged) return new Date(current.endsAt);
    return previewBoardEnd(durationKind, endDate);
  }, [current?.endsAt, windowChanged, durationKind, endDate]);

  /** Cards due after the new end, which the server will pull in to it. */
  const pulledIn = useMemo(() => {
    if (!board || !newEnd || !windowChanged) return 0;
    return board.tasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() > newEnd.getTime()).length;
  }, [board?.tasks, newEnd, windowChanged]);

  const endsInPast = windowChanged && newEnd !== null && newEnd.getTime() < Date.now();

  const submit = async () => {
    if (!current) return;
    if (!name.trim()) {
      setError("Give the board a name");
      return;
    }
    if (durationKind === "custom" && !endDate) {
      setError("A custom duration needs an end date");
      return;
    }

    const patch: Parameters<typeof api.updateBoard>[1] = {};
    if (name.trim() !== current.name) patch.name = name.trim();
    if ((description.trim() || null) !== (current.description ?? null)) {
      // An empty string clears it; the server stores that as no description.
      patch.description = description.trim();
    }
    if (projectId !== current.projectId) patch.project = projectId;
    if (kindChanged) patch.durationKind = durationKind;
    // Core keeps the board's start when only the end moves.
    if (windowChanged && durationKind === "custom") patch.endsAt = `${endDate}T23:59:59`;

    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.updateBoard(current.id, patch);
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save the board");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open && board !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit board</DialogTitle>
          <DialogDescription>
            Rename it, move its deadline, or change where its work happens. Cards and their history stay as they are.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Duration</Label>
            <Select value={durationKind} onValueChange={(value) => setDurationKind(value as DurationKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {DURATION_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {durationKind === "custom" ? (
            <div className="space-y-1.5">
              <Label>Ends on</Label>
              <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label hint={kindChanged ? "from today" : "unchanged"}>Everything due by</Label>
              <div className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-surface/60 px-3 text-sm">
                <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{newEnd ? formatDateTime(newEnd.toISOString()) : "—"}</span>
              </div>
            </div>
          )}
        </div>

        {windowChanged && (pulledIn > 0 || endsInPast) ? (
          <div
            className="space-y-1 rounded-md border px-2.5 py-2 text-[12px]"
            style={{
              borderColor: "color-mix(in oklab, var(--prio-high) 35%, transparent)",
              backgroundColor: "color-mix(in oklab, var(--prio-high) 8%, transparent)",
            }}
          >
            {pulledIn > 0 ? (
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" style={{ color: "var(--prio-high)" }} />
                <span>
                  {pulledIn} card{pulledIn === 1 ? " is" : "s are"} due after this. Saving moves{" "}
                  {pulledIn === 1 ? "its due date" : "their due dates"} in to{" "}
                  {newEnd ? formatDateTime(newEnd.toISOString()) : "the new end"}.
                </span>
              </p>
            ) : null}
            {endsInPast ? (
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" style={{ color: "var(--prio-high)" }} />
                <span>That date has already passed, so the board will show as expired.</span>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label hint="optional">What is this board for</Label>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Context that helps Claude pick up work from here."
            rows={2}
          />
        </div>

        <div className="space-y-1.5">
          <Label hint="where its work happens">Project</Label>
          <ProjectSelect projects={projects} value={projectId} onChange={setProjectId} ariaLabel="Board project" />
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
