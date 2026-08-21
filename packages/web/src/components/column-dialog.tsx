import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { COLUMN_KIND_LABELS, kindColor, type BoardColumn, type BoardDetail, type ColumnKind } from "@/lib/types";

const KINDS: ColumnKind[] = ["backlog", "active", "blocked", "review", "done"];

/**
 * Add or edit a state. `kind` is exposed deliberately: it decides which cards
 * count as done, blocked or in review in the stats and in what Claude reads.
 */
export function ColumnDialog({
  board,
  column,
  open,
  onOpenChange,
  onSaved,
}: {
  board: BoardDetail | null;
  /** null = adding a new state. */
  column: BoardColumn | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ColumnKind>("backlog");
  const [wipLimit, setWipLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(column?.name ?? "");
    setKind(column?.kind ?? "backlog");
    setWipLimit(column?.wipLimit ? String(column.wipLimit) : "");
    setError(null);
  }, [open, column?.id]);

  const submit = async () => {
    if (!board) return;
    if (!name.trim()) {
      setError("A state needs a name");
      return;
    }
    const limit = wipLimit.trim() === "" ? null : Number(wipLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      setError("The WIP limit has to be a whole number of 1 or more");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (column) {
        await api.updateColumn(board.board.id, column.id, { name: name.trim(), kind, wipLimit: limit });
      } else {
        await api.addColumn(board.board.id, { name: name.trim(), kind, wipLimit: limit });
      }
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save the state");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open && board !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{column ? "Edit state" : "Add a state"}</DialogTitle>
          <DialogDescription>
            Columns are per-board, so you can go past the defaults — a "Waiting on legal" or "Ready to deploy" lane is
            fine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ready to deploy"
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label hint="drives the stats">Counts as</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as ColumnKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: kindColor(entry) }} />
                      {COLUMN_KIND_LABELS[entry]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label hint="optional">WIP limit</Label>
            <Input
              type="number"
              min={1}
              value={wipLimit}
              onChange={(event) => setWipLimit(event.target.value)}
              placeholder="no limit"
            />
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={saving}>
            {column ? "Save state" : "Add state"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
