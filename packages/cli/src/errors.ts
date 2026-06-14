export type ErrorCode = "E_UNKNOWN" | "E_NO_ROUTES" | "E_BAD_ARGS" | "E_NOT_IMPLEMENTED" | "E_UNAUTHORIZED" | "E_NETWORK";

const EXIT_CODES: Record<ErrorCode, number> = {
  E_BAD_ARGS: 2,
  E_NOT_IMPLEMENTED: 5,
  E_UNAUTHORIZED: 1,
  E_NETWORK: 1,
  E_NO_ROUTES: 1,
  E_UNKNOWN: 1,
};

export function exitCodeFor(code: string): number {
  return EXIT_CODES[code as ErrorCode] ?? 1;
}

export class PodkitError extends Error {
  code: ErrorCode;
  hint: string | undefined;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "PodkitError";
    this.code = code;
    this.hint = hint;
  }
}
