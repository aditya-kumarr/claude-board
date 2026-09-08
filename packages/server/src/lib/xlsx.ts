import ExcelJS from "exceljs";
import type { BoardExport } from "@automation/core";

/**
 * Writes a board export as a real `.xlsx`.
 *
 * Lives in the server rather than core because it is the one thing here that
 * needs a dependency able to emit cell styles and data validation — core builds
 * the table and the closed value sets, this turns them into a sheet somebody can
 * actually work in.
 *
 * The dropdowns are the point of using xlsx at all. `ExportField.options` is
 * declared next to the data, so a State cell offers exactly this board's columns
 * rather than a list inferred from whichever values happen to appear.
 */

/**
 * Rows past the last card that still carry the dropdowns.
 *
 * Kept small on purpose. Every spare row is inside the sheet's used range, so a
 * generous buffer means select-all-and-sort quietly picks up blanks — and since
 * nothing imports these files back, rows added by hand are for the reader's own
 * working, not for this app. A handful is useful; a few hundred is a mess.
 */
const SPARE_ROWS = 20;

const HEADER_FILL = "FF1F2937";
const HEADER_FONT = "FFF9FAFB";
const BANDING_FILL = "FFF6F7F9";

const columnLetter = (index: number): string => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** Excel rejects an inline validation list longer than about 255 characters. */
const inlineList = (options: string[]): string | null => {
  const joined = options.join(",");
  return joined.length <= 250 ? `"${joined}"` : null;
};

export async function boardToXlsx(data: BoardExport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Board";
  workbook.created = new Date(data.generatedAt);

  /* ------------------------------------------------------------------ tasks */

  const sheet = workbook.addWorksheet("Tasks", {
    // Headers and the id/title columns stay put while scrolling a wide sheet.
    views: [{ state: "frozen", ySplit: 1, xSplit: 2 }],
  });

  sheet.columns = data.fields.map((field) => ({ header: field.header, width: field.width }));

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF111827" } } };
  });

  for (const row of data.rows) {
    sheet.addRow(
      row.map((value, index) =>
        // Real dates, so sorting and filtering behave like dates rather than text.
        data.fields[index]!.date && typeof value === "string" ? new Date(value) : value,
      ),
    );
  }

  data.fields.forEach((field, index) => {
    const column = sheet.getColumn(index + 1);
    if (field.date) column.numFmt = "yyyy-mm-dd hh:mm";
    column.alignment = field.wrap
      ? { wrapText: true, vertical: "top" }
      : { vertical: "top", horizontal: typeof data.rows[0]?.[index] === "number" ? "right" : "left" };
  });

  // Banding over the data rows only.
  for (let r = 3; r <= data.rows.length + 1; r += 2) {
    sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BANDING_FILL } };
    });
  }

  // Validation runs past the last card so rows added by hand behave too.
  const lastRow = data.rows.length + 1 + SPARE_ROWS;
  data.fields.forEach((field, index) => {
    if (!field.options?.length) return;
    const formulae = inlineList(field.options);
    if (!formulae) return;
    const letter = columnLetter(index);
    for (let r = 2; r <= lastRow; r += 1) {
      sheet.getCell(`${letter}${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [formulae],
        showErrorMessage: true,
        // A warning rather than a hard stop: this file is a report first, and
        // refusing a paste outright is worse than flagging it.
        errorStyle: "warning",
        errorTitle: `${field.header} is a fixed set`,
        error: `Pick one of: ${field.options.join(", ")}.`,
      };
    }
  });

  if (data.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: data.rows.length + 1, column: data.fields.length },
    };
  }

  /* ---------------------------------------------------------------- summary */

  const about = workbook.addWorksheet("Board");
  about.columns = [
    { header: "Field", width: 16 },
    { header: "Value", width: 72 },
  ];
  about.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  for (const [key, value] of data.summary) about.addRow([key, value]);
  about.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
