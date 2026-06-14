// Per-project request metrics. A sealed in-process registry that accumulates
// only counts, status-class buckets, and latency for each project slug. It
// never stores request bodies, headers, paths, or any caller-supplied content
// beyond the (router-validated) slug, is never persisted to disk/DB/network,
// and resets on process restart.

export interface MetricsRecord {
  slug: string;
  statusCode: number;
  latencyMs: number;
}

export interface MetricsSnapshot {
  requests: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  avgLatencyMs: number;
  lastSeen: number;
}

export interface MetricsRegistry {
  record(m: MetricsRecord): void;
  snapshot(slug: string): MetricsSnapshot | null;
}

interface Accumulator {
  requests: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  latencyTotalMs: number;
  lastSeen: number;
}

export function createMetricsRegistry(): MetricsRegistry {
  const byslug = new Map<string, Accumulator>();

  return {
    record(m: MetricsRecord): void {
      let acc = byslug.get(m.slug);
      if (!acc) {
        acc = {
          requests: 0,
          status2xx: 0,
          status3xx: 0,
          status4xx: 0,
          status5xx: 0,
          latencyTotalMs: 0,
          lastSeen: 0,
        };
        byslug.set(m.slug, acc);
      }
      acc.requests += 1;
      // Coerce the status code into a fixed bucket; anything outside the known
      // HTTP class ranges is ignored for class counts (but still counted as a
      // request and toward latency).
      const code = m.statusCode;
      if (code >= 200 && code < 300) acc.status2xx += 1;
      else if (code >= 300 && code < 400) acc.status3xx += 1;
      else if (code >= 400 && code < 500) acc.status4xx += 1;
      else if (code >= 500 && code < 600) acc.status5xx += 1;
      const latency = Number.isFinite(m.latencyMs) && m.latencyMs >= 0 ? m.latencyMs : 0;
      acc.latencyTotalMs += latency;
      acc.lastSeen = Date.now();
    },
    snapshot(slug: string): MetricsSnapshot | null {
      const acc = byslug.get(slug);
      if (!acc) return null;
      return {
        requests: acc.requests,
        status2xx: acc.status2xx,
        status3xx: acc.status3xx,
        status4xx: acc.status4xx,
        status5xx: acc.status5xx,
        avgLatencyMs: acc.requests > 0 ? acc.latencyTotalMs / acc.requests : 0,
        lastSeen: acc.lastSeen,
      };
    },
  };
}
