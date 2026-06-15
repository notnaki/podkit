import type { IncomingMessage } from "node:http";

// Thrown by readBody when the request body exceeds the byte cap. The servers
// translate it to a 413 response. (A plain Error subclass — erasable TS: no
// parameter properties.)
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body into a Buffer, rejecting with BodyTooLargeError once more
 * than `limit` bytes have arrived (and destroying the stream so we stop reading).
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const onData = (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        cleanup();
        // Don't destroy the socket — the caller drains it (req.resume()) and
        // sends a proper 413. Removing the data listener stops us buffering.
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Parse an `application/x-www-form-urlencoded` body into a flat record. Repeated
 * keys keep the last value. Decoding (`+` → space, `%XX`) is handled by
 * URLSearchParams.
 */
export function parseFormUrlEncoded(body: Buffer | string): Record<string, string> {
  const text = typeof body === "string" ? body : body.toString("utf8");
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}
