#!/usr/bin/env node
// Not published — this only matters for local testing via `npm link` (see README.md).
// Spawns node with tsx's loader registered so src/index.ts runs directly, no build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const entry = join(dir, "..", "src", "index.ts");
// A bare "tsx/esm" --import specifier resolves relative to the CALLER's cwd, not this
// package's own node_modules — breaks the moment `codeferret` runs from any other repo
// (exactly what npm link is for). Resolve the real path from here instead.
const tsxEsmUrl = import.meta.resolve("tsx/esm");
const result = spawnSync(process.execPath, ["--import", tsxEsmUrl, entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
