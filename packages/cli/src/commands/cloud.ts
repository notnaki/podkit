import { fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

type Method = "GET" | "POST";

async function callControlPlane(
  method: Method,
  path: string,
  body?: unknown,
): Promise<Envelope<unknown>> {
  const base = process.env.PODKIT_API_URL ?? "http://localhost:8080";
  const key = process.env.PODKIT_API_KEY ?? "";

  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-podkit-key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return fail(
      new PodkitError(
        "E_NETWORK",
        "control-plane unreachable",
        "is it running? set PODKIT_API_URL",
      ),
    );
  }

  return (await response.json()) as Envelope<unknown>;
}

export async function cloudCommand(args: string[]): Promise<Envelope<unknown>> {
  const [subcommand, ...rest] = args;

  try {
    if (subcommand === "projects") {
      return await callControlPlane("GET", "/v1/projects");
    }

    if (subcommand === "create") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "create requires a slug",
            "Available: projects, create <slug>, deploy <slug>, url <slug>",
          ),
        );
      }
      return await callControlPlane("POST", "/v1/projects", {
        slug,
        owner: process.env.USER ?? "cli",
      });
    }

    if (subcommand === "deploy") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "deploy requires a slug",
            "Available: projects, create <slug>, deploy <slug>, url <slug>",
          ),
        );
      }
      return await callControlPlane("POST", `/v1/projects/${slug}/deploy`, {
        contextDir: process.cwd(),
        containerPort: Number(process.env.PODKIT_APP_PORT ?? 3000),
      });
    }

    if (subcommand === "url") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "url requires a slug",
            "Available: projects, create <slug>, deploy <slug>, url <slug>",
          ),
        );
      }
      return await callControlPlane("GET", `/v1/projects/${slug}`);
    }

    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand
          ? `Unknown cloud subcommand: ${subcommand}`
          : "No cloud subcommand given",
        "Available: projects, create <slug>, deploy <slug>, url <slug>",
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
