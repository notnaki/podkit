export type ErrorCode = "E_UNKNOWN" | "E_NO_ROUTES" | "E_BAD_ARGS";

export class PodkitError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "PodkitError";
  }
}
