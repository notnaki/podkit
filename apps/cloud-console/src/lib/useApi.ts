import { useCallback, useEffect, useState } from "react";
import type { Envelope } from "../api/client.ts";

export interface AsyncState<T> {
  loading: boolean;
  data: T | null;
  error: { code: string; message: string; hint?: string } | null;
  reload: () => void;
}

// Runs an Envelope-returning call, exposing loading/data/error + a reload().
// Pass `pollMs` to refresh in the background on an interval (e.g. to keep live
// state like a project sleeping/waking current without a manual reload).
export function useApi<T>(
  fn: () => Promise<Envelope<T>>,
  deps: unknown[] = [],
  pollMs?: number,
): AsyncState<T> {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: AsyncState<T>["error"] }>({
    loading: true,
    data: null,
    error: null,
  });

  // silent: a background refresh that never flips `loading` (no UI flicker).
  const run = useCallback((silent = false) => {
    let alive = true;
    if (!silent) setState((s) => ({ ...s, loading: true }));
    fn().then((res) => {
      if (!alive) return;
      if (res.ok) setState({ loading: false, data: res.data, error: null });
      else setState({ loading: false, data: null, error: res.error });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => run(true), pollMs);
    return () => clearInterval(id);
  }, [run, pollMs]);

  return { ...state, reload: () => run() };
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
