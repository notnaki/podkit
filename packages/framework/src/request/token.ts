type HeaderValue = string | string[] | undefined;

const headerString = (value: HeaderValue): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const findHeader = (
  headers: Record<string, HeaderValue>,
  name: string,
): string | undefined => {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headerString(headers[key]);
    }
  }
  return undefined;
};

const BEARER_PREFIX = "bearer ";

/**
 * Extracts an auth token from request headers.
 *
 * Precedence:
 * 1. An `authorization` header (case-insensitive key) whose value starts with
 *    "Bearer " (case-insensitive) — returns the trimmed remainder.
 * 2. A `podkit_session=<value>` entry in the `cookie` header.
 * 3. Otherwise `null`.
 */
export const extractToken = (
  headers: Record<string, HeaderValue>,
): string | null => {
  const authorization = findHeader(headers, "authorization");
  if (authorization !== undefined && authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim();
  }

  const cookie = findHeader(headers, "cookie");
  if (cookie !== undefined) {
    for (const pair of cookie.split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      if (key === "podkit_session") {
        return pair.slice(eq + 1).trim();
      }
    }
  }

  return null;
};
