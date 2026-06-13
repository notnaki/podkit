import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  buildArtifact,
  publishVersion,
  listVersions,
  promote,
  getCurrent,
  rollback,
  initDeploy,
  readDeploy,
  claimDeploy,
} from "@podkit/deploy";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

export async function deployCommand(args: string[]): Promise<Envelope<unknown>> {
  const [subcommand, ...rest] = args;

  const appRoot = process.cwd();
  const deploysRoot = join(appRoot, ".podkit/deploys");
  const artifactsRoot = join(appRoot, ".podkit/artifacts");

  try {
    if (subcommand === "up") {
      mkdirSync(deploysRoot, { recursive: true });
      mkdirSync(artifactsRoot, { recursive: true });

      const id = "v" + randomBytes(6).toString("hex");
      const outDir = join(artifactsRoot, id);

      buildArtifact({ appRoot, outDir, builtAt: Date.now() });
      publishVersion({ artifactDir: outDir, deploysRoot, id });
      initDeploy(deploysRoot, "dep_" + randomBytes(6).toString("hex"));
      promote(deploysRoot, id);

      return ok({
        versionId: id,
        deployId: readDeploy(deploysRoot)?.deployId,
        current: getCurrent(deploysRoot),
      });
    }

    if (subcommand === "promote") {
      const [id] = rest;
      if (!id) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "promote requires a version id",
            "Usage: podkit deploy promote <versionId>",
          ),
        );
      }
      mkdirSync(deploysRoot, { recursive: true });
      promote(deploysRoot, id);
      return ok({ current: id });
    }

    if (subcommand === "rollback") {
      mkdirSync(deploysRoot, { recursive: true });
      const r = rollback(deploysRoot);
      return ok(r);
    }

    if (subcommand === "deployments") {
      return ok({
        versions: listVersions(deploysRoot),
        current: getCurrent(deploysRoot),
      });
    }

    if (subcommand === "claim") {
      const [owner] = rest;
      if (!owner) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "claim requires an owner",
            "Usage: podkit deploy claim <owner>",
          ),
        );
      }
      mkdirSync(deploysRoot, { recursive: true });
      claimDeploy(deploysRoot, owner);
      return ok(readDeploy(deploysRoot));
    }

    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand
          ? `Unknown deploy subcommand: ${subcommand}`
          : "No deploy subcommand given",
        "Available deploy subcommands: up, promote, rollback, deployments, claim",
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
