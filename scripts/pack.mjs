#!/usr/bin/env node
/**
 * pack.mjs — cross-platform tarball packaging: ensures dist/ exists, then
 * runs `npm pack` into it. Used by CI, release, and local development.
 */
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(root, "dist"), { recursive: true });

const result = spawnSync("npm", ["pack", "--pack-destination", path.join(root, "dist")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});

process.exit(result.status === null ? 1 : result.status);
