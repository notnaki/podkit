// Per-account aggregate resource caps, enforced at create/deploy in host.ts.
//
// These extend the existing per-account PROJECT quota (count of projects an
// account may own) with caps on the resources the account's ACTIVE deployments
// consume in aggregate: total memory (MB) and total container count, summed
// across every running container the account currently owns.
//
// All tenant containers run with the SAME memory limit (the runtime's default,
// 512m), so aggregate memory is simply (active container count) *
// (per-container memory MB). That lets us enforce a real memory cap without a
// schema migration to record per-deployment memory.
//
// ponytail: memory + container-count caps, derived from a uniform per-container
// memory figure. Recording an actual per-deployment memory limit (so apps can
// request different sizes) and summing those is the upgrade. Disk caps are
// skipped: per-container disk usage isn't meterable locally without cgroup/
// overlay accounting, so we deliberately don't pretend to enforce it here.

export type AccountCaps = {
  // Max total memory (MB) across the account's active containers. 0 = unlimited.
  maxMemoryMb: number;
  // Max active containers the account may run at once. 0 = unlimited.
  maxContainers: number;
  // Memory (MB) each tenant container is given — used to convert a container
  // count into an aggregate memory figure. Must match the runtime default.
  perContainerMemoryMb: number;
};

export type CapDecision =
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      hint: string;
    };

// Decide whether starting ONE more container would keep the account within its
// caps. `activeContainers` is the number of containers the account currently
// runs (across all its projects). Pure + synchronous so it's trivially testable;
// the caller is responsible for counting active containers from the store.
//
// Over-cap is reported as 429 (Too Many Requests) with a structured code/hint,
// matching the existing quota error shape (code + message + hint) but using 429
// rather than 403 because the limit is a transient resource ceiling the account
// can clear by stopping a deployment, not an authorization failure.
export function checkAccountCaps(
  caps: AccountCaps,
  activeContainers: number,
): CapDecision {
  // Container-count cap. The new container would be #(activeContainers + 1).
  if (caps.maxContainers > 0 && activeContainers + 1 > caps.maxContainers) {
    return {
      ok: false,
      status: 429,
      code: "E_QUOTA_CONTAINERS",
      message:
        "active container limit reached (" +
        caps.maxContainers +
        ")",
      hint: "stop a running deployment/preview, or ask the operator to raise PODKIT_MAX_CONTAINERS_PER_ACCOUNT",
    };
  }
  // Aggregate memory cap. Project what total memory would be AFTER this deploy.
  if (caps.maxMemoryMb > 0) {
    const projectedMb = (activeContainers + 1) * caps.perContainerMemoryMb;
    if (projectedMb > caps.maxMemoryMb) {
      return {
        ok: false,
        status: 429,
        code: "E_QUOTA_MEMORY",
        message:
          "account memory limit reached (" +
          caps.maxMemoryMb +
          "MB; each container uses " +
          caps.perContainerMemoryMb +
          "MB)",
        hint: "stop a running deployment/preview, or ask the operator to raise PODKIT_MAX_MEMORY_MB_PER_ACCOUNT",
      };
    }
  }
  return { ok: true };
}
