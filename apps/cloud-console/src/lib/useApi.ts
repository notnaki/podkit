import { useCallback, useEffect, useState } from "react";
import type { Envelope } from "../api/client.ts";
import { getApiUrl, getToken } from "../api/client.ts";

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

// Live project status over SSE, with a graceful poll fallback.
//
// Subscribes to GET /v1/projects/:slug/events (an SSE stream emitting
// {"status":"ready|sleeping|waking"}). While the stream is healthy it returns
// the latest status and `live: true`. If EventSource errors or the connection
// closes, it stops the stream and signals `live: false`, so the caller can fall
// back to its existing poll. Re-subscribes when the slug changes.
//
// ponytail: EventSource for live status, poll as fallback. EventSource can't set
// an Authorization header, so the token rides as a query param (the vite proxy
// forwards /v1, and the control-plane accepts it on this read-only stream).
export interface LiveStatus {
  status: "ready" | "sleeping" | "waking" | null;
  live: boolean;
}

export function useLiveStatus(slug: string | null): LiveStatus {
  const [state, setState] = useState<LiveStatus>({ status: null, live: false });

  useEffect(() => {
    setState({ status: null, live: false });
    if (!slug || typeof EventSource === "undefined") return;

    const base = getApiUrl();
    const token = getToken();
    const path = `/v1/projects/${encodeURIComponent(slug)}/events`;
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const href = (base === "" ? path : base.replace(/\/$/, "") + path) + qs;

    const es = new EventSource(href);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { status?: string };
        if (data.status === "ready" || data.status === "sleeping" || data.status === "waking") {
          setState({ status: data.status, live: true });
        }
      } catch {
        // Ignore malformed frames; the poll fallback still covers correctness.
      }
    };
    es.onopen = () => setState((s) => ({ ...s, live: true }));
    es.onerror = () => {
      // Stream failed or closed: stop it and let the caller's poll take over.
      es.close();
      setState({ status: null, live: false });
    };

    return () => es.close();
  }, [slug]);

  return state;
}

// Live container log tail over SSE. Subscribes to GET /v1/projects/:slug/logs/stream
// and accumulates lines while `enabled`. Same query-param token as useLiveStatus.
// ponytail: keeps only the last MAX_LIVE_LINES in memory; no reconnect-on-drop
// (the caller can toggle off/on). Upgrade: backoff reconnect + a Last-Event-ID cursor.
export interface LiveLogs {
  text: string;
  connected: boolean;
}

const MAX_LIVE_LINES = 2000;

export function useLiveLogs(slug: string | null, enabled: boolean): LiveLogs {
  const [state, setState] = useState<LiveLogs>({ text: "", connected: false });

  useEffect(() => {
    setState({ text: "", connected: false });
    if (!enabled || !slug || typeof EventSource === "undefined") return;

    const base = getApiUrl();
    const token = getToken();
    const path = `/v1/projects/${encodeURIComponent(slug)}/logs/stream`;
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const href = (base === "" ? path : base.replace(/\/$/, "") + path) + qs;

    const buf: string[] = [];
    const es = new EventSource(href);
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { line?: string };
        if (typeof data.line === "string") {
          buf.push(data.line);
          if (buf.length > MAX_LIVE_LINES) buf.splice(0, buf.length - MAX_LIVE_LINES);
          setState({ text: buf.join("\n"), connected: true });
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    es.onerror = () => {
      es.close();
      setState((s) => ({ ...s, connected: false }));
    };

    return () => es.close();
  }, [slug, enabled]);

  return state;
}

// Pure status resolution shared by the list cards and the project page: the live
// SSE status wins when present; otherwise we fall back to the polled snapshot.
// Returned `cls` is a status pill className; `label` is the human label.
export interface ResolvedStatus {
  cls: string;
  label: string;
}

export function resolveStatus(
  live: LiveStatus["status"],
  snapshot: { status?: string | null; version?: string | null; sleeping?: boolean },
): ResolvedStatus {
  // Live status, when present, fully determines the pill.
  if (live === "waking") return { cls: "status status-building", label: "Waking" };
  if (live === "ready") return { cls: "status status-ready", label: "Ready" };
  if (live === "sleeping") return { cls: "status status-none", label: "Sleeping" };

  // Snapshot fallback: a sleeping container overrides its (immutable) deployment
  // status, matching the runtime reality.
  if (snapshot.sleeping) return { cls: "status status-none", label: "Sleeping" };
  if (snapshot.status === "running") return { cls: "status status-ready", label: "Ready" };
  if (snapshot.version) {
    const s = snapshot.status;
    if (s === "building") return { cls: "status status-building", label: s };
    if (s) return { cls: "status status-error", label: s };
  }
  return { cls: "status status-none", label: "No deployment" };
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
