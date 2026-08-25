#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8")
);
const args = process.argv.slice(2);

function printHelp() {
  console.log(`Install the Cournot agent skill.

Usage:
  npx cournot-skills add <source> [skills add options]

Examples:
  npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot
  npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot --global --agent codex --yes

The wrapper forwards the source and options to the skills CLI and always uses
copy mode.`);
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

const [command, source, ...options] = args;

if (command !== "add" || !source || source.startsWith("-")) {
  printHelp();
  process.exit(1);
}

const require = createRequire(import.meta.url);
const skillsPackageRoot = dirname(require.resolve("skills/package.json"));
const skillsCli = join(skillsPackageRoot, "bin", "cli.mjs");
const forwardedOptions = options.filter((option) => option !== "--copy");
const result = spawnSync(
  process.execPath,
  [skillsCli, "add", source, "--copy", ...forwardedOptions],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  }
);

if (result.error) {
  console.error(
    `cournot-skills: failed to start the skills installer: ${result.error.message}`
  );
  process.exit(1);
}

const exitCode = result.status ?? 1;
process.exit(exitCode);
