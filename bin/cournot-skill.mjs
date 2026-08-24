#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractWelcome, shouldShowWelcome } from "../lib/welcome.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8")
);
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Install the Cournot agent skill.

Usage:
  npx cournot-skill [skills add options]

Examples:
  npx cournot-skill
  npx cournot-skill --global --agent codex --yes

The installer always copies the skill so it remains available after the npx
cache is cleaned. A successful fresh installation prints the Cournot welcome
message; an overwrite, list operation, or failed installation does not.`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

const skillPath = join(packageRoot, "skills", "cournot");
const skillFile = join(skillPath, "SKILL.md");
let welcome;

try {
  welcome = extractWelcome(readFileSync(skillFile, "utf8"));
} catch (error) {
  console.error(`cournot-skill: ${error.message}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const skillsPackageRoot = dirname(require.resolve("skills/package.json"));
const skillsCli = join(skillsPackageRoot, "bin", "cli.mjs");
const forwardedArgs = args.filter((arg) => arg !== "--copy");
const result = spawnSync(
  process.execPath,
  [skillsCli, "add", skillPath, "--copy", ...forwardedArgs],
  {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error) {
  console.error(
    `cournot-skill: failed to start the skills installer: ${result.error.message}`
  );
  process.exit(1);
}

const exitCode = result.status ?? 1;
const installerOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

if (shouldShowWelcome(installerOutput, exitCode)) {
  console.log(`\n${welcome}\n`);
}

process.exit(exitCode);
