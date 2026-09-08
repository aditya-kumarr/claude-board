import { Fragment, useMemo, type ReactNode } from "react";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Must agree with `parseMentions` in core: the same leading guard, so an email
 * address in a comment is not painted as a mention here and then quietly ignored
 * by the parser that decides what becomes a request.
 */
const MENTION = /(^|[^\w@/])@([a-z][a-z0-9_-]{0,30})/gi;

/** Conversational aliases core also resolves to the agent. */
const AGENT_ALIASES = ["you", "agent", "assistant"];

/** Lower-cased handles that reach an agent, from the seeded user list. */
export function agentHandles(users: User[]): Set<string> {
  const handles = new Set(AGENT_ALIASES);
  for (const user of users) {
    if (user.kind !== "agent") continue;
    handles.add(user.id.toLowerCase());
    handles.add(user.displayName.toLowerCase());
  }
  return handles;
}

export function hasAgentMention(text: string, handles: Set<string>): boolean {
  for (const match of text.matchAll(MENTION)) {
    if (handles.has((match[2] ?? "").toLowerCase())) return true;
  }
  return false;
}

/**
 * Splits a run of text into plain and mention parts.
 *
 * Exported because the markdown renderer needs the same split inside every text
 * node it emits, and the one thing that must not happen is a second copy of the
 * regex above drifting from core's: a mention the UI paints and the parser then
 * ignores is a request the user believes they made and nobody received.
 */
export function splitMentions(text: string, handles: Set<string>): Array<{ text: string; mention: boolean }> {
  const out: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? "";
    const handle = match[2] ?? "";
    if (!handles.has(handle.toLowerCase())) continue;
    const at = (match.index ?? 0) + lead.length;
    if (at > cursor) out.push({ text: text.slice(cursor, at), mention: false });
    out.push({ text: `@${handle}`, mention: true });
    cursor = at + handle.length + 1;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), mention: false });
  return out;
}

/** The highlight itself, so the markdown renderer paints mentions identically. */
export function MentionChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-primary/15 px-1 py-px font-medium text-primary ring-1 ring-inset ring-primary/25">
      {children}
    </span>
  );
}

/** Mention-highlighted nodes for one run of plain text. */
export function mentionNodes(text: string, handles: Set<string>, keyPrefix = "m"): ReactNode[] {
  return splitMentions(text, handles).map((part, index) =>
    part.mention ? (
      <MentionChip key={`${keyPrefix}-${index}`}>{part.text}</MentionChip>
    ) : (
      <Fragment key={`${keyPrefix}-${index}`}>{part.text}</Fragment>
    ),
  );
}

/**
 * Comment body with agent mentions picked out. A mention is the difference
 * between a note and a request, so it has to look different from the prose
 * around it — otherwise the user cannot tell which of their comments actually
 * asked Claude for something.
 *
 * Plain text only. A comment Claude wrote is markdown and goes through
 * `<Markdown>` instead, which reuses the same highlighting inside its text nodes.
 */
export function MentionText({ text, handles, className }: { text: string; handles: Set<string>; className?: string }) {
  const nodes = useMemo(() => mentionNodes(text, handles), [text, handles]);
  return <span className={cn("whitespace-pre-wrap break-words", className)}>{nodes}</span>;
}
