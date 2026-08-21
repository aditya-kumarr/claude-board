import { randomUUID } from "node:crypto";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * Short, unambiguous, prefixed ids (`tsk_k4m9p2xw`). Readable enough that a
 * human and an agent can talk about the same task over a chat transcript,
 * which plain UUIDs make painful.
 */
export function newId(prefix: string, size = 8): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newRequestId = (): string => randomUUID().slice(0, 8);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "untitled";
}
