import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DeployMeta {
  deployId: string;
  claimed: boolean;
  owner?: string;
}

function metaPath(root: string): string {
  return join(root, "podkit.json");
}

function writeMeta(root: string, meta: DeployMeta): DeployMeta {
  writeFileSync(metaPath(root), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

export function readDeploy(root: string): DeployMeta | null {
  const path = metaPath(root);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as DeployMeta;
}

export function initDeploy(root: string, deployId: string): DeployMeta {
  const existing = readDeploy(root);
  if (existing) return existing;
  return writeMeta(root, { deployId, claimed: false });
}

export function claimDeploy(root: string, owner: string): DeployMeta {
  const existing = readDeploy(root);
  if (!existing) throw new Error("no deploy to claim");
  return writeMeta(root, { ...existing, claimed: true, owner });
}
