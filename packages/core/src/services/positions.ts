import type { Database } from "bun:sqlite";

const GAP = 1024;

/**
 * Fractional ordering: a card dropped between two others gets the midpoint of
 * their positions, so a reorder touches one row instead of renumbering a column.
 */
export function positionForAppend(db: Database, columnId: string): number {
  const row = db
    .query<{ max: number | null }, [string]>("SELECT MAX(position) AS max FROM tasks WHERE column_id = ?")
    .get(columnId);
  return (row?.max ?? 0) + GAP;
}

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return GAP;
  if (before === null) return (after as number) - GAP;
  if (after === null) return before + GAP;
  return (before + after) / 2;
}

/**
 * Places a task at `index` within a column, ignoring the task itself so that
 * moving a card inside its own column computes against its future neighbours.
 */
export function positionAtIndex(db: Database, columnId: string, index: number, excludeTaskId?: string): number {
  const rows = db
    .query<{ id: string; position: number }, [string]>(
      "SELECT id, position FROM tasks WHERE column_id = ? ORDER BY position ASC",
    )
    .all(columnId)
    .filter((row) => row.id !== excludeTaskId);

  const clamped = Math.max(0, Math.min(index, rows.length));
  const before = clamped === 0 ? null : (rows[clamped - 1]?.position ?? null);
  const after = clamped >= rows.length ? null : (rows[clamped]?.position ?? null);
  return positionBetween(before, after);
}

/** Rebuilds evenly spaced positions when midpoints get too close to split. */
export function normalizeColumn(db: Database, columnId: string): void {
  const rows = db
    .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE column_id = ? ORDER BY position ASC")
    .all(columnId);
  const update = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
  rows.forEach((row, index) => update.run((index + 1) * GAP, row.id));
}

export const MIN_POSITION_GAP = 0.0001;
