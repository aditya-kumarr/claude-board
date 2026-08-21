import { useMemo, useState } from "react";
import { CalendarRange, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { DURATION_LABELS, type DurationKind } from "@/lib/types";

const KINDS: DurationKind[] = ["day", "week", "month", "quarter", "year", "custom"];
const DEFAULT_COLUMNS = ["To do", "Doing", "Blocked", "Needs review", "Done"];

/** Local preview of the server's window maths, so the deadline is visible before saving. */
function previewWindow(kind: DurationKind, endsAt: string): string {
  const now = new Date();
  const end = (() => {
    switch (kind) {
      case "day":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
      case "week": {
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 6);
        monday.setHours(23, 59);
        return monday;
      }
      case "month":
        return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59);
      case "quarter":
        return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0, 23, 59);
      case "year":
        return new Date(now.getFullYear(), 11, 31, 23, 59);
      case "custom":
        return endsAt ? new Date(`${endsAt}T23:59`) : null;
    }
  })();
  if (!end || Number.isNaN(end.getTime())) return "pick an end date";
  return formatDateTime(end.toISOString());
}

export function CreateBoardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (boardId: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [durationKind, setDurationKind] = useState<DurationKind>("week");
  const [endsAt, setEndsAt] = useState("");
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [newColumn, setNewColumn] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deadline = useMemo(() => previewWindow(durationKind, endsAt), [durationKind, endsAt]);

  const reset = () => {
    setName("");
    setDescription("");
    setDurationKind("week");
    setEndsAt("");
    setColumns(DEFAULT_COLUMNS);
    setNewColumn("");
    setError(null);
  };

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the board a name");
      return;
    }
    if (durationKind === "custom" && !endsAt) {
      setError("A custom duration needs an end date");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const detail = await api.createBoard({
        name: name.trim(),
        durationKind,
        description: description.trim() || undefined,
        endsAt: durationKind === "custom" ? `${endsAt}T23:59:59` : undefined,
        columns: columns.length && columns.join() !== DEFAULT_COLUMNS.join() ? columns : undefined,
      });
      reset();
      onOpenChange(false);
      onCreated(detail.board.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the board");
    } finally {
      setSaving(false);
    }
  };

  const addColumn = () => {
    const value = newColumn.trim();
    if (!value || columns.length >= 12) return;
    if (columns.some((column) => column.toLowerCase() === value.toLowerCase())) return;
    setColumns((current) => [...current, value]);
    setNewColumn("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>
            The duration is a hard deadline — every task on this board has to finish inside the window, and tasks
            without their own date inherit the board's end.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ship the MCP server"
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
              <Input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label hint="calculated">Everything due by</Label>
              <div className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-surface/60 px-3 text-sm">
                <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{deadline}</span>
              </div>
            </div>
          )}
        </div>

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
          <Label hint={`${columns.length} of 12`}>States</Label>
          <div className="flex flex-wrap gap-1.5">
            {columns.map((column) => (
              <Badge key={column} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1">
                {column}
                <button
                  type="button"
                  onClick={() => setColumns((current) => current.filter((entry) => entry !== column))}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                  aria-label={`Remove ${column}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={newColumn}
              onChange={(event) => setNewColumn(event.target.value)}
              placeholder="Add a state, e.g. Waiting on review"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addColumn();
                }
              }}
              className="h-8"
            />
            <Button variant="outline" size="sm" onClick={addColumn} disabled={!newColumn.trim()}>
              <Plus /> Add
            </Button>
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            Create board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
