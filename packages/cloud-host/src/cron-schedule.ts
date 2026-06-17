// ponytail: minimal schedule grammar (no full 5-field cron);
// upgrade to a cron-parser dep if real cron expressions are needed.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

// Parse the interval from a recognized schedule string.
// Returns interval in milliseconds, or null if unrecognized/invalid.
function intervalMs(schedule: string): number | null {
  if (schedule === "@hourly") return HOUR_MS;
  if (schedule === "@daily") return 24 * HOUR_MS;

  const everyMatch = /^@every (\d+)(m|h)$/.exec(schedule);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    if (n <= 0) return null;
    return everyMatch[2] === "h" ? n * HOUR_MS : n * MIN_MS;
  }

  const stepMatch = /^\*\/(\d+)$/.exec(schedule);
  if (stepMatch) {
    const n = Number(stepMatch[1]);
    if (n <= 0) return null;
    return n * MIN_MS;
  }

  return null;
}

export function isValidSchedule(schedule: string): boolean {
  return intervalMs(schedule) !== null;
}

// Returns true when the cron should fire now:
//   - never-run (lastRunAtMs === null) -> always due
//   - elapsed time >= configured interval -> due
export function isDue(
  schedule: string,
  lastRunAtMs: number | null,
  nowMs: number,
): boolean {
  const interval = intervalMs(schedule);
  if (interval === null) return false; // unknown format -> never due
  if (lastRunAtMs === null) return true; // first run
  return nowMs - lastRunAtMs >= interval;
}
