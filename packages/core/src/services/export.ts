import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { notFound } from "../lib/errors.ts";
import { PRIORITIES, type Priority } from "../types.ts";
import { listColumns } from "./columns.ts";
import { listUsers } from "./users.ts";

/**
 * Exporting a board as a table.
 *
 * The shape lives here rather than in a route because *which* fields make a
 * board legible outside the app is a decision about the domain, not about HTTP —
 * and both transports offer the export. Encoding is split off: CSV is built here
 * because it needs nothing, and XLSX in the server, which owns the one dependency
 * that can write data validation and cell styles.
 */

/** A column in the exported table, and what it is allowed to contain. */
export interface ExportField {
  /** Header text, written as-is. */
  header: string;
  /** Rendering width hint, in characters. */
  width: number;
  /**
   * Closed set of values, when the field has one. This is what becomes a dropdown
   * in the spreadsheet, so it is defined next to the data rather than guessed by
   * the writer from the values that happen to appear.
   */
  options?: string[];
  /** Long free text, so the cell should wrap rather than stretch the column. */
  wrap?: boolean;
  /** Written as a real date/time rather than a string. */
  date?: boolean;
}

export interface BoardExport {
  boardId: string;
  boardName: string;
  /** Safe for a filename: no separators, no spaces. */
  slug: string;
  generatedAt: string;
  fields: ExportField[];
  /** Row values, aligned to `fields`. Dates are ISO strings; the writer converts. */
  rows: Array<Array<string | number | null>>;
  /** Board-level facts worth carrying out with the rows. */
  summary: Array<[string, string]>;
}

const UNASSIGNED = "(unassigned)";

/** `Work — week of Aug 24` -> `work-week-of-aug-24`, for a filename. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "board";
}

type Row = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  due_at: string | null;
  completed_at: string | null;
  blocked_reason: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  assignee_id: string | null;
  created_by: string;
  column_name: string;
  column_kind: string;
  position: number;
  project_name: string | null;
  project_path: string | null;
  comments: number;
  open_mentions: number;
  open_responses: number;
};

/**
 * One board as a table, ordered the way the board reads: left to right by
 * column, top to bottom within it. Counts come from the same query rather than a
 * lookup per row, because a board of a few hundred cards would otherwise be a
 * few hundred round trips.
 */
export function buildBoardExport(boardId: string): BoardExport {
  const db = getDb();
  const board = db
    .query<{ id: string; name: string; description: string | null; duration_kind: string; starts_at: string; ends_at: string; archived: number }, [string]>(
      "SELECT id, name, description, duration_kind, starts_at, ends_at, archived FROM boards WHERE id = ?",
    )
    .get(boardId);
  // A domain error, not a programming slip: the MCP tool calls this with whatever
  // board id the model produced, so it has to come back as a readable not_found
  // rather than an opaque 500.
  if (!board) throw notFound("board", boardId);

  const columns = listColumns(boardId);
  const users = listUsers();

  const rows = db
    .query<Row, SQLQueryBindings[]>(
      `SELECT t.id, t.title, t.description, t.priority, t.due_at, t.completed_at, t.blocked_reason,
              t.source_ref, t.created_at, t.updated_at, t.assignee_id, t.created_by, t.position,
              c.name AS column_name, c.kind AS column_kind,
              p.name AS project_name, p.path AS project_path,
              (SELECT COUNT(*) FROM task_comments cm WHERE cm.task_id = t.id) AS comments,
              (SELECT COUNT(*) FROM task_mentions m
                WHERE m.task_id = t.id AND m.status IN ('pending','claimed')) AS open_mentions,
              (SELECT COUNT(*) FROM task_responses r
                WHERE r.task_id = t.id AND r.status NOT IN ('sent','discarded')) AS open_responses
         FROM tasks t
         JOIN board_columns c ON c.id = t.column_id
         LEFT JOIN projects p ON p.id = COALESCE(t.project_id, (SELECT project_id FROM boards WHERE id = t.board_id))
        WHERE t.board_id = ?
        ORDER BY c.position ASC, t.position ASC`,
    )
    .all(boardId);

  const who = (id: string | null): string => {
    if (id === null) return UNASSIGNED;
    return users.find((user) => user.id === id)?.displayName ?? id;
  };

  const now = Date.now();
  const fields: ExportField[] = [
    { header: "ID", width: 14 },
    { header: "Title", width: 52 },
    { header: "State", width: 16, options: columns.map((column) => column.name) },
    { header: "Kind", width: 11, options: [...new Set(columns.map((column) => column.kind))] },
    { header: "Assignee", width: 13, options: [UNASSIGNED, ...users.map((user) => user.displayName)] },
    { header: "Priority", width: 11, options: [...PRIORITIES] },
    { header: "Due", width: 18, date: true },
    { header: "Overdue", width: 9, options: ["yes", "no"] },
    { header: "Completed", width: 18, date: true },
    { header: "Blocked reason", width: 30, wrap: true },
    { header: "Comments", width: 10 },
    { header: "Open @claude", width: 13 },
    { header: "Draft replies", width: 13 },
    { header: "Project", width: 22 },
    { header: "Imported from", width: 26 },
    { header: "Created by", width: 12 },
    { header: "Created", width: 18, date: true },
    { header: "Updated", width: 18, date: true },
    { header: "Description", width: 70, wrap: true },
  ];

  const table = rows.map((row) => [
    row.id,
    row.title,
    row.column_name,
    row.column_kind,
    who(row.assignee_id),
    row.priority as Priority,
    row.due_at,
    row.column_kind !== "done" && row.due_at !== null && new Date(row.due_at).getTime() < now ? "yes" : "no",
    row.completed_at,
    row.blocked_reason,
    row.comments,
    row.open_mentions,
    row.open_responses,
    row.project_name ? `${row.project_name} — ${row.project_path}` : null,
    row.source_ref,
    who(row.created_by),
    row.created_at,
    row.updated_at,
    row.description,
  ]);

  const done = rows.filter((row) => row.column_kind === "done").length;
  return {
    boardId,
    boardName: board.name,
    slug: slugify(board.name),
    generatedAt: new Date().toISOString(),
    fields,
    rows: table,
    summary: [
      ["Board", board.name],
      ["Board id", board.id],
      ["Duration", board.duration_kind],
      ["Window", `${board.starts_at} to ${board.ends_at}`],
      ["Archived", board.archived === 1 ? "yes" : "no"],
      ["Tasks", String(rows.length)],
      ["Done", String(done)],
      ["Outstanding", String(rows.length - done)],
      ["Exported", new Date().toISOString()],
      ...(board.description ? ([["Note", board.description]] as Array<[string, string]>) : []),
    ],
  };
}

/**
 * Neutralises a value a spreadsheet would otherwise execute.
 *
 * Cards on this board are built from email and chat, so their text is attacker
 * -adjacent by construction: a subject line of `=HYPERLINK(...)` becomes a live
 * formula the moment the CSV is opened. Prefixing with an apostrophe is the
 * conventional fix and keeps the text readable.
 */
function deFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = deFormula(value);
  // Quote when the value could otherwise break the row apart, doubling any
  // quote of its own. Descriptions carry newlines routinely.
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface CsvOptions {
  /** Prepend the board summary as `# key,value` lines. Default false. */
  includeSummary?: boolean;
}

export function toCsv(data: BoardExport, options: CsvOptions = {}): string {
  const lines: string[] = [];
  if (options.includeSummary) {
    for (const [key, value] of data.summary) lines.push(`# ${csvCell(key)},${csvCell(value)}`);
    lines.push("");
  }
  lines.push(data.fields.map((field) => csvCell(field.header)).join(","));
  for (const row of data.rows) lines.push(row.map(csvCell).join(","));
  // CRLF and a BOM: Excel reads a bare LF file as one column, and without the
  // BOM it mis-decodes the non-ASCII that names and em dashes bring in.
  return `﻿${lines.join("\r\n")}\r\n`;
}
