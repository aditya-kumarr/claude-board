import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { WhatsAppMediaKind, WhatsAppMediaState } from "../types.ts";

/**
 * Reading a WhatsApp "Export chat" text file into messages.
 *
 * There is no one format. The two phone platforms write different line prefixes,
 * and the date inside them follows the phone's locale — so the same 3 March is
 * `03/03/2025, 14:05` on one phone and `[3/3/25, 2:05:09 PM]` on another:
 *
 *   iOS      [DD/MM/YYYY, HH:MM:SS] Author: text
 *            [DD/MM/YYYY, HH:MM:SS] Author: <attached: 00000012-PHOTO-2025-03-03-14-05-09.jpg>
 *   Android  DD/MM/YYYY, HH:MM - Author: text
 *            DD/MM/YYYY, HH:MM - Author: IMG-20250303-WA0004.jpg (file attached)
 *
 * A line that does not open with a timestamp continues the message above it,
 * which is how multi-line messages and photo captions arrive.
 *
 * Day-first versus month-first cannot be told from one line, so it is decided
 * across the whole file: any first field above 12 settles day-first, any second
 * field above 12 settles month-first. A chat where neither happens (every date so
 * far on or before the 12th) falls back to the caller's default and says so,
 * because guessing wrong silently moves every message by months.
 *
 * Nothing here touches the database. It is pure so the rules for what a message
 * *is* can be read in one place.
 */

export type DateOrder = "dmy" | "mdy";

export interface ParsedWhatsAppMessage {
  /** Position in the file, from 0. */
  seq: number;
  /** ISO, read in this machine's local time — the export carries no timezone. */
  sentAt: string;
  /** Null for system lines ("Messages are end-to-end encrypted", "X added Y"). */
  author: string | null;
  /** Text with the media marker removed — for a photo, its caption. */
  body: string;
  mediaName: string | null;
  mediaState: WhatsAppMediaState | null;
  mediaKind: WhatsAppMediaKind | null;
  /**
   * Stable identity across exports. Two exports of one chat produce the same
   * fingerprint for the same message, which is what lets a re-upload of the full
   * history pick up only what is new.
   */
  fingerprint: string;
}

export interface ParsedWhatsAppChat {
  messages: ParsedWhatsAppMessage[];
  dateOrder: DateOrder;
  /** True when the file itself never disambiguated day and month. */
  dateOrderGuessed: boolean;
  /** Lines before the first timestamp — normally none; many means the wrong file. */
  unparsedLines: number;
}

/** Direction marks and no-break spaces WhatsApp sprinkles through the export. */
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ODD_SPACES = /[\u00a0\u202f\u2007]/g;

const DATE = String.raw`(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([AaPp])\.?\s?[Mm]\.?)?`;
const IOS_LINE = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s?(.*)$`);
const ANDROID_LINE = new RegExp(String.raw`^${DATE},?\s+${TIME}\s[-–]\s(.*)$`);

/** "Name: text". Authors are short and never contain a colon; bodies often do. */
const AUTHOR = /^([^:\n]{1,80}?):\s?([\s\S]*)$/;

const IOS_ATTACHED = /<attached:\s*([^>]+?)\s*>/i;
/** English markers; other locales fall through to the zip-name match below. */
const OMITTED = /^(?:<media omitted>|(?:image|video|audio|sticker|gif|document|contact card) omitted|this message was deleted|you deleted this message)$/i;

interface RawLine {
  a: number;
  b: number;
  c: number;
  hour: number;
  minute: number;
  second: number;
  meridiem: string | undefined;
  rest: string;
}

function matchLine(line: string): RawLine | null {
  const match = IOS_LINE.exec(line) ?? ANDROID_LINE.exec(line);
  if (!match) return null;
  return {
    a: Number(match[1]),
    b: Number(match[2]),
    c: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    meridiem: match[7]?.toLowerCase(),
    rest: match[8] ?? "",
  };
}

function toIso(line: RawLine, order: DateOrder): string | null {
  let year: number;
  let month: number;
  let day: number;
  if (line.a > 999) {
    // Year first (some locales): always Y/M/D.
    [year, month, day] = [line.a, line.b, line.c];
  } else {
    year = line.c < 100 ? 2000 + line.c : line.c;
    [day, month] = order === "dmy" ? [line.a, line.b] : [line.b, line.a];
  }
  let hour = line.hour;
  if (line.meridiem === "p" && hour < 12) hour += 12;
  if (line.meridiem === "a" && hour === 12) hour = 0;
  const date = new Date(year, month - 1, day, hour, line.minute, line.second);
  // Reject what Date would silently roll over (31/02 becoming 3 March).
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.toISOString();
}

const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"]);
const VIDEO = new Set([".mp4", ".mov", ".3gp", ".mkv", ".avi"]);
const AUDIO = new Set([".opus", ".ogg", ".m4a", ".mp3", ".aac", ".amr", ".wav"]);
const DOCUMENT = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".zip"]);
/** What the Read tool can actually look at. HEIC is a photo it cannot open. */
const READABLE_PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export function mediaKindOf(filename: string): WhatsAppMediaKind {
  const ext = extname(filename).toLowerCase();
  // Stickers are .webp, so the name has to decide before the extension does.
  if (/^STK-|-STICKER-/i.test(filename)) return "sticker";
  if (PHOTO.has(ext)) return "photo";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (DOCUMENT.has(ext)) return "document";
  return "other";
}

export const isReadablePhoto = (filename: string): boolean =>
  mediaKindOf(filename) === "photo" && READABLE_PHOTO.has(extname(filename).toLowerCase());

/**
 * Pulls the media reference out of a message body. `archiveNames` is every file
 * in the zip. It is what catches Android's localised "(file attached)" /
 * "(archivo adjunto)" marker without a list of languages: if the first line
 * starts with the name of a file in the archive, that is the attachment.
 */
function splitMedia(
  body: string,
  archiveNames: ReadonlySet<string>,
): Pick<ParsedWhatsAppMessage, "body" | "mediaName" | "mediaState"> {
  const ios = IOS_ATTACHED.exec(body);
  if (ios) {
    const name = ios[1]!.trim();
    return {
      body: body.replace(ios[0], "").trim(),
      mediaName: name,
      mediaState: archiveNames.has(name) ? "attached" : "missing",
    };
  }

  const [first = "", ...rest] = body.split("\n");
  const token = first.trim().split(/\s+/)[0] ?? "";
  if (token && archiveNames.has(token)) {
    return { body: rest.join("\n").trim(), mediaName: token, mediaState: "attached" };
  }
  // Android names the file even when it is not in the export: "IMG-….jpg (file attached)".
  const named = /^(\S+\.[A-Za-z0-9]{2,5})\s+\([^)]{3,40}\)$/.exec(first.trim());
  if (named && /^(IMG|VID|AUD|PTT|STK|DOC)-\d{8}-WA\d+/i.test(named[1]!)) {
    return { body: rest.join("\n").trim(), mediaName: named[1]!, mediaState: "missing" };
  }

  if (OMITTED.test(first.trim())) {
    return { body: rest.join("\n").trim(), mediaName: null, mediaState: "omitted" };
  }
  return { body: body.trim(), mediaName: null, mediaState: null };
}

export function parseWhatsAppChat(
  text: string,
  options: { archiveNames: ReadonlySet<string>; fallbackOrder?: DateOrder },
): ParsedWhatsAppChat {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // Pass 1: find the message boundaries and settle the date order.
  const starts: Array<{ raw: RawLine; body: string[] }> = [];
  let unparsedLines = 0;
  let dayFirst = false;
  let monthFirst = false;
  for (const original of lines) {
    const line = original.replace(INVISIBLE, "").replace(ODD_SPACES, " ");
    const raw = matchLine(line);
    if (raw) {
      if (raw.a <= 999) {
        if (raw.a > 12) dayFirst = true;
        if (raw.b > 12) monthFirst = true;
      }
      starts.push({ raw, body: [raw.rest] });
    } else if (starts.length > 0) {
      starts[starts.length - 1]!.body.push(original.replace(INVISIBLE, ""));
    } else if (line.trim()) {
      unparsedLines++;
    }
  }

  const dateOrderGuessed = dayFirst === monthFirst;
  const dateOrder: DateOrder = dateOrderGuessed ? (options.fallbackOrder ?? "dmy") : dayFirst ? "dmy" : "mdy";

  // Pass 2: build messages. Identical (time, author, text) triples are real — "ok"
  // twice in a minute — so the fingerprint counts occurrences to keep them apart.
  const seen = new Map<string, number>();
  const messages: ParsedWhatsAppMessage[] = [];
  for (const start of starts) {
    const sentAt = toIso(start.raw, dateOrder);
    if (!sentAt) {
      unparsedLines++;
      continue;
    }
    const joined = start.body.join("\n").replace(/\s+$/, "");
    const authored = AUTHOR.exec(joined);
    const author = authored ? authored[1]!.trim() : null;
    const media = splitMedia(authored ? authored[2]! : joined, options.archiveNames);

    const identity = `${sentAt}|${author ?? ""}|${joined}`;
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);

    messages.push({
      seq: messages.length,
      sentAt,
      author,
      body: media.body,
      mediaName: media.mediaName,
      mediaState: media.mediaState,
      mediaKind: media.mediaName ? mediaKindOf(media.mediaName) : null,
      fingerprint: createHash("sha1").update(`${identity}#${occurrence}`).digest("hex").slice(0, 16),
    });
  }

  return { messages, dateOrder, dateOrderGuessed, unparsedLines };
}

/**
 * The chat's name from the export's own file names. iOS puts it only on the zip
 * ("WhatsApp Chat - Ravi.zip", holding `_chat.txt`); Android puts it on the text
 * file too ("WhatsApp Chat with Ravi.txt"). A browser's " (1)" suffix on a second
 * download is stripped, or the same chat would become two.
 */
export function chatNameFrom(zipName: string, textName: string): string {
  const clean = (name: string) =>
    name
      .replace(/\.(zip|txt)$/i, "")
      .replace(/\s*\(\d+\)$/, "")
      .replace(/^WhatsApp Chat\s*(?:-|with|–)\s*/i, "")
      .trim();
  const fromText = /^_chat$/i.test(textName.replace(/\.txt$/i, "")) ? "" : clean(textName);
  return fromText || clean(zipName) || "WhatsApp chat";
}
