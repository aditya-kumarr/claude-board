import { Fragment, useMemo } from "react";
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
 * Comment body with agent mentions picked out. A mention is the difference
 * between a note and a request, so it has to look different from the prose
 * around it — otherwise the user cannot tell which of their comments actually
 * asked Claude for something.
 */
export function MentionText({ text, handles, className }: { text: string; handles: Set<string>; className?: string }) {
  const parts = useMemo(() => {
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
  }, [text, handles]);

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((part, index) =>
        part.mention ? (
          <span
            key={index}
            className="rounded bg-primary/15 px-1 py-px font-medium text-primary ring-1 ring-inset ring-primary/25"
          >
            {part.text}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </span>
  );
}
