/**
 * Parsing for the `@handle` syntax used in comment bodies.
 *
 * Lives here rather than in the mentions service because it is pure text work
 * with no database in it, and because the web client renders the same tokens as
 * highlighted chips — the two have to agree on what counts as a mention.
 */

/**
 * A mention is an `@` that starts a word, followed by a handle.
 *
 * The leading `[^\w@/]` guard is what keeps `aditya@example.com`, `a/@b` and
 * `foo@@claude` from reading as mentions: an address or a path fragment has a
 * word character or a slash immediately before the `@`, a real mention never
 * does. Trailing punctuation is excluded by the handle class, so "@claude, can
 * you…" yields `claude`.
 */
const MENTION = /(?:^|[^\w@/])@([a-z][a-z0-9_-]{0,30})/gi;

export interface ParsedMention {
  /** Lower-cased handle as written, without the `@`. Resolve it against users. */
  handle: string;
  /** Index of the `@` in the source text. */
  at: number;
  /** The literal matched text, `@` included. */
  text: string;
}

/** Every mention in `body`, in the order written, duplicates included. */
export function parseMentions(body: string): ParsedMention[] {
  if (!body.includes("@")) return [];
  const found: ParsedMention[] = [];
  for (const match of body.matchAll(MENTION)) {
    const handle = match[1];
    if (handle === undefined) continue;
    const at = (match.index ?? 0) + match[0].indexOf("@");
    found.push({ handle: handle.toLowerCase(), at, text: `@${handle}` });
  }
  return found;
}

/** Distinct handles in `body`, first-mention order. */
export function mentionedHandles(body: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const mention of parseMentions(body)) {
    if (seen.has(mention.handle)) continue;
    seen.add(mention.handle);
    order.push(mention.handle);
  }
  return order;
}

/**
 * The instruction part of a comment: everything after the first mention of
 * `handle`, with the mention token itself dropped. "@claude bump this to urgent"
 * becomes "bump this to urgent". Falls back to the whole body when the mention
 * trails the request ("can you look at this @claude") so nothing is ever lost.
 */
export function requestText(body: string, handle: string): string {
  const target = handle.toLowerCase();
  const first = parseMentions(body).find((mention) => mention.handle === target);
  if (!first) return body.trim();
  const after = body.slice(first.at + first.text.length).replace(/^\s*[,:;-]?\s*/, "").trim();
  return after.length > 0 ? after : body.trim();
}
