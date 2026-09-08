import { Fragment, useMemo, type ReactNode } from "react";
import { mentionNodes } from "@/components/mention-text";
import { cn } from "@/lib/utils";

/**
 * Markdown for the comment thread.
 *
 * Claude writes markdown — headings, bullets, `code`, fenced blocks — and until
 * now the thread rendered it as literal asterisks and backticks, which is worst
 * exactly where it matters most: a run reporting what it changed writes a list of
 * files, and a list of files is the thing that turned into a wall.
 *
 * Written here rather than pulled in as a dependency for one reason that is not
 * taste: mention highlighting has to happen *inside* the text nodes, and the
 * regex doing it must stay the single copy that agrees with core's parser (see
 * mention-text.tsx). Routing that through a general markdown pipeline's node
 * overrides means re-splitting its children anyway, so the subset is parsed here
 * and `mentionNodes` is called on every run of plain text.
 *
 * The subset is what an agent writing a status update actually uses: headings,
 * ordered and unordered lists (nested), fenced and inline code, bold, italic,
 * strikethrough, links, block quotes, tables and rules. Anything outside it
 * survives as its own text rather than disappearing — an unclosed fence is
 * rendered as a code block, not swallowed.
 */

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "para"; text: string };

const FENCE = /^ {0,3}(```+|~~~+)\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const isBlank = (line: string) => line.trim() === "";

/** A pipe row split into cells, tolerating the optional leading/trailing pipe. */
function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * Lines into blocks. Lists and quotes recurse on their own content, which is what
 * makes a fenced code block inside a bullet — the shape "here is the diff I
 * applied, step 2" naturally takes — come out right.
 */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      i += 1;
      // An unclosed fence runs to the end on purpose: a truncated comment should
      // still show its code as code rather than as prose full of backticks.
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang: fence[2] ?? "", code: code.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]!) || (!isBlank(lines[i]!) && quoted.length > 0))) {
        quoted.push(lines[i]!.replace(QUOTE, ""));
        i += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(quoted.join("\n")) });
      continue;
    }

    // A table needs its divider row to be a table at all, so both lines are
    // checked before either is consumed.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && !isBlank(lines[i]!)) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: Block[][] = [];

      while (i < lines.length) {
        const current = lines[i]!.match(LIST_ITEM);
        // A different marker family starts a new list rather than continuing this
        // one, so a numbered plan following a bullet summary is not renumbered.
        if (!current || /\d/.test(current[2]!) !== ordered || current[1]!.length > 0) break;

        const indent = current[1]!.length + current[2]!.length + current[3]!.length;
        const content = [current[4] ?? ""];
        i += 1;

        // Continuation: anything indented under the marker belongs to this item,
        // and a blank line only ends it if what follows is not indented too.
        while (i < lines.length) {
          const next = lines[i]!;
          if (isBlank(next)) {
            const after = lines[i + 1];
            if (after === undefined || (!isBlank(after) && after.search(/\S/) < indent)) break;
            content.push("");
            i += 1;
            continue;
          }
          if (next.search(/\S/) < indent) break;
          content.push(next.slice(indent));
          i += 1;
        }
        items.push(parseBlocks(content.join("\n")));
      }

      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!)) {
      const next = lines[i]!;
      if (paragraph.length > 0 && (FENCE.test(next) || HEADING.test(next) || HR.test(next) || LIST_ITEM.test(next) || QUOTE.test(next))) {
        break;
      }
      paragraph.push(next);
      i += 1;
    }
    blocks.push({ type: "para", text: paragraph.join("\n") });
  }

  return blocks;
}

/* ------------------------------------------------------------------- inline */

/**
 * One pass over the alternation below. Code spans come first in the pattern so
 * everything inside a backtick is left alone — `**kwargs` in a comment about
 * Python is not bold.
 */
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/g;

/** Only schemes that cannot execute anything if the link is clicked. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

const codeClass =
  "rounded border border-border/70 bg-muted px-1 py-px font-mono text-[0.9em] text-card-foreground break-words";

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  );
}

/**
 * Inline markdown for one run of text, with soft line breaks preserved. Claude
 * writes a status update the way it writes a message — one fact per line, no
 * blank line between them — and collapsing those into a paragraph the way strict
 * markdown does would undo the formatting rather than apply it.
 */
function inline(text: string, handles: Set<string>, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const plain = (value: string) => {
    if (!value) return;
    // Soft breaks are rendered, so a list of files stays a list of files.
    const segments = value.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) out.push(<br key={`${keyPrefix}-br-${key++}`} />);
      if (segment) out.push(<Fragment key={`${keyPrefix}-t-${key++}`}>{mentionNodes(segment, handles, `${keyPrefix}-${key}`)}</Fragment>);
    });
  };

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    const [whole, , code, strongStar, strongUnderscore, strike, emStar, emUnderscore, linkText, linkHref, autoAngle, autoBare] =
      match;

    // Emphasis on an underscore only counts between non-word characters, or
    // every snake_case identifier in a comment about code comes out italic.
    if (emUnderscore !== undefined) {
      const before = text[at - 1] ?? " ";
      const after = text[at + whole.length] ?? " ";
      if (/\w/.test(before) || /\w/.test(after)) continue;
    }

    plain(text.slice(cursor, at));
    cursor = at + whole.length;

    if (code !== undefined) {
      out.push(
        <code key={`${keyPrefix}-c-${key++}`} className={codeClass}>
          {code.replace(/^ (.*) $/, "$1")}
        </code>,
      );
    } else if (strongStar !== undefined || strongUnderscore !== undefined) {
      const body = (strongStar ?? strongUnderscore)!;
      out.push(
        <strong key={`${keyPrefix}-b-${key++}`} className="font-semibold">
          {inline(body, handles, `${keyPrefix}-b${key}`)}
        </strong>,
      );
    } else if (strike !== undefined) {
      out.push(
        <span key={`${keyPrefix}-s-${key++}`} className="line-through opacity-70">
          {inline(strike, handles, `${keyPrefix}-s${key}`)}
        </span>,
      );
    } else if (emStar !== undefined || emUnderscore !== undefined) {
      const body = (emStar ?? emUnderscore)!;
      out.push(
        <em key={`${keyPrefix}-i-${key++}`} className="italic">
          {inline(body, handles, `${keyPrefix}-i${key}`)}
        </em>,
      );
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (href) {
        out.push(
          <InlineLink key={`${keyPrefix}-l-${key++}`} href={href}>
            {inline(linkText || href, handles, `${keyPrefix}-l${key}`)}
          </InlineLink>,
        );
      } else {
        plain(whole);
      }
    } else {
      const raw = (autoAngle ?? autoBare)!;
      const href = safeHref(raw);
      if (href) {
        out.push(
          <InlineLink key={`${keyPrefix}-a-${key++}`} href={href}>
            {raw}
          </InlineLink>,
        );
      } else {
        plain(whole);
      }
    }
  }

  plain(text.slice(cursor));
  return out;
}

/* -------------------------------------------------------------------- blocks */

const HEADING_CLASS: Record<number, string> = {
  1: "text-[15px] font-semibold",
  2: "text-[14px] font-semibold",
  3: "text-[13.5px] font-semibold",
  4: "text-[13px] font-semibold",
  5: "text-[13px] font-medium",
  6: "text-[12.5px] font-medium uppercase tracking-wide text-muted-foreground",
};

function renderBlocks(blocks: Block[], handles: Set<string>, keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case "code":
        return (
          // Its own scroll container: a stack trace or a wide diff must not be
          // what makes the dialog scroll sideways.
          <pre
            key={key}
            className="overflow-x-auto rounded-md border border-border/70 bg-muted/60 p-2 scrollbar-slim"
          >
            <code className="font-mono text-[12px] leading-relaxed text-card-foreground">{block.code}</code>
          </pre>
        );
      case "heading": {
        const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
        return (
          <Tag key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[3]}>
            {inline(block.text, handles, key)}
          </Tag>
        );
      }
      case "hr":
        return <hr key={key} className="border-border/70" />;
      case "quote":
        return (
          <blockquote key={key} className="space-y-1.5 border-l-2 border-border pl-2.5 text-muted-foreground">
            {renderBlocks(block.children, handles, key)}
          </blockquote>
        );
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag
            key={key}
            start={block.ordered ? block.start : undefined}
            className={cn(
              "space-y-1 pl-5",
              block.ordered ? "list-decimal marker:text-muted-foreground" : "list-disc marker:text-muted-foreground",
            )}
          >
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-i${itemIndex}`} className="space-y-1.5">
                {renderBlocks(item, handles, `${key}-i${itemIndex}`)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={key} className="overflow-x-auto scrollbar-slim">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th
                      key={`${key}-h${cellIndex}`}
                      className="border border-border/70 bg-muted/50 px-1.5 py-1 text-left font-medium"
                    >
                      {inline(cell, handles, `${key}-h${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-r${rowIndex}`}>
                    {block.header.map((_, cellIndex) => (
                      <td key={`${key}-r${rowIndex}c${cellIndex}`} className="border border-border/70 px-1.5 py-1 align-top">
                        {inline(row[cellIndex] ?? "", handles, `${key}-r${rowIndex}c${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return (
          <p key={key} className="break-words">
            {inline(block.text, handles, key)}
          </p>
        );
    }
  });
}

/** A markdown body, with `@mentions` highlighted the same way plain text is. */
export function Markdown({ text, handles, className }: { text: string; handles: Set<string>; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className={cn("space-y-2 break-words", className)}>{renderBlocks(blocks, handles, "b")}</div>;
}
