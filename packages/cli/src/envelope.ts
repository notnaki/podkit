import { PodkitError } from "./errors.ts";

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; hint: string | undefined } };

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function fail(err: unknown): Envelope<never> {
  if (err instanceof PodkitError) {
    return { ok: false, error: { code: err.code, message: err.message, hint: err.hint } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "E_UNKNOWN", message, hint: undefined } };
}
