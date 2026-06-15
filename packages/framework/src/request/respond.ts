import type { IncomingMessage, ServerResponse } from "node:http";
import { runAction, type RouteModule } from "../loader/run.ts";
import { readBody, parseFormUrlEncoded, BodyTooLargeError } from "./body.ts";
import { serializeCookie } from "./cookie.ts";

// Cap form bodies at 1 MiB; larger ⇒ 413. (Mirrors the control-plane's readJson cap.)
const BODY_LIMIT = 1024 * 1024;

export interface ActionRequestBase {
  params: Record<string, string>;
  url: URL;
  auth: { userId: string; isAgent: boolean } | null;
  method: string;
}

/**
 * Handle a non-GET/HEAD request for a matched route, shared by the dev and prod
 * servers so their behaviour is identical:
 *  - no `action` exported        → 405 Method Not Allowed
 *  - body over the cap           → 413 Payload Too Large
 *  - otherwise                   → run the action, apply Set-Cookie headers,
 *                                  303 redirect (Post/Redirect/Get)
 *
 * Returns the HTTP status written. If the action throws, this rethrows so the
 * caller's catch turns it into a 500 (consistent with loader errors).
 */
export async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  mod: RouteModule,
  base: ActionRequestBase,
): Promise<number> {
  if (typeof mod.action !== "function") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return 405;
  }

  let formData: Record<string, string>;
  try {
    formData = parseFormUrlEncoded(await readBody(req, BODY_LIMIT));
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      req.resume(); // drain the rest of the body so the socket completes cleanly
      res.statusCode = 413;
      res.end("Payload Too Large");
      return 413;
    }
    throw err;
  }

  const result = await runAction(mod, { ...base, formData });
  for (const cookie of result.cookies ?? []) {
    res.appendHeader("set-cookie", serializeCookie(cookie));
  }
  res.statusCode = 303;
  res.setHeader("location", result.redirect);
  res.end();
  return 303;
}
