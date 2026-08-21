import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { BoardDetail, User } from "@/lib/types";

const POLL_MS = 2500;

/**
 * Board state plus a lightweight change feed.
 *
 * The MCP server writes straight to SQLite, so this process never sees those
 * mutations as HTTP traffic. Instead we poll a cheap monotonic `revision`
 * counter and only refetch the boards when it moves — which is how a card
 * Claude moved appears here within a couple of seconds without websockets.
 */
export function useBoards() {
  const [boards, setBoards] = useState<BoardDetail[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Set when the last refresh came from a remote change rather than our own action. */
  const [remoteChangeAt, setRemoteChangeAt] = useState<number | null>(null);

  const revisionRef = useRef<number>(-1);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [{ boards: next }, { revision }] = await Promise.all([api.listBoards(), api.revision()]);
      revisionRef.current = revision;
      setBoards(next);
      setError(null);
    } catch (cause) {
      if (!options.silent) {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Cannot reach the API. Is `bun run dev:server` running on port 4000?",
        );
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.users().then(({ users: list }) => setUsers(list)).catch(() => setUsers([]));
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { revision } = await api.revision();
        if (cancelled) return;
        if (revisionRef.current !== -1 && revision !== revisionRef.current) {
          setRemoteChangeAt(Date.now());
          await refresh({ silent: true });
        } else {
          revisionRef.current = revision;
          setError(null);
        }
      } catch {
        // Offline is reported by the next explicit refresh; stay quiet here so a
        // brief server restart does not flash an error banner.
      }
    };
    const handle = setInterval(tick, POLL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(handle);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { boards, users, loading, error, refresh, remoteChangeAt };
}

/** Re-renders on an interval so "2d 4h left" counts down without a refetch. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}
