export type ErrorCode = "E_UNKNOWN" | "E_NO_ROUTES" | "E_BAD_ARGS";

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
