export type Handler = (ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}) =>
  | Promise<{ status: number; body: unknown }>
  | { status: number; body: unknown };

type Route = {
  method: string;
  segments: string[];
  handler: Handler;
};

const splitSegments = (path: string): string[] =>
  path.split("/").filter((s) => s.length > 0);

export function createRouter(): {
  register(method: string, pattern: string, h: Handler): void;
  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | null;
} {
  const routes: Route[] = [];

  return {
    register(method: string, pattern: string, h: Handler): void {
      routes.push({
        method: method.toUpperCase(),
        segments: splitSegments(pattern),
        handler: h,
      });
    },

    match(
      method: string,
      path: string,
    ): { handler: Handler; params: Record<string, string> } | null {
      const wantMethod = method.toUpperCase();
      const pathSegments = splitSegments(path);

      for (const route of routes) {
        if (route.method !== wantMethod) continue;
        if (route.segments.length !== pathSegments.length) continue;

        const params: Record<string, string> = {};
        let matched = true;

        for (let i = 0; i < route.segments.length; i++) {
          const seg = route.segments[i]!;
          const value = pathSegments[i]!;
          if (seg.startsWith(":")) {
            params[seg.slice(1)] = value;
          } else if (seg !== value) {
            matched = false;
            break;
          }
        }

        if (matched) {
          return { handler: route.handler, params };
        }
      }

      return null;
    },
  };
}

export function sendJson(
  res: { statusCode: number; setHeader(k: string, v: string): void; end(s: string): void },
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

type ReadableLike = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
};

export function readJson(req: ReadableLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err: unknown) => {
      reject(err);
    });
  });
}
