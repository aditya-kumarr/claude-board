import { getDb } from "../db/index.ts";
import { toUser, type UserRow } from "../db/rows.ts";
import { notFound } from "../lib/errors.ts";
import { USER_CLAUDE, USER_ME, type User } from "../types.ts";

export function listUsers(): User[] {
  return getDb().query<UserRow, []>("SELECT * FROM users ORDER BY kind DESC, id ASC").all().map(toUser);
}

/**
 * Accepts an id or display name, case-insensitively, plus the natural aliases a
 * conversation produces — "you"/"claude"/"agent" for the agent, "me"/"i" for the
 * human. Without this the agent would have to guess the literal row id.
 */
export function requireUser(reference: string): User {
  const key = reference.trim().toLowerCase();
  const alias =
    key === "you" || key === "agent" || key === "assistant" || key === "claude"
      ? USER_CLAUDE
      : key === "i" || key === "me" || key === "myself" || key === "user" || key === "human"
        ? USER_ME
        : key;

  const row = getDb()
    .query<UserRow, [string, string]>("SELECT * FROM users WHERE lower(id) = ? OR lower(display_name) = ?")
    .get(alias, alias);
  if (!row) {
    const known = listUsers().map((u) => u.id);
    throw notFound(`assignee '${reference}' (known assignees: ${known.join(", ")})`);
  }
  return toUser(row);
}
