#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractWelcome,
  findInstalledSkillPath,
  shouldShowWelcome,
} from "../lib/welcome.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8")
);
const args = process.argv.slice(2);

function printHelp() {
  console.log(`Install the Cournot agent skill and show its welcome message.

Usage:
  npx cournot-skills add <source> [skills add options]

Examples:
  npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot
  npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot --global --agent codex --yes

The wrapper forwards the source and options to the skills CLI and always uses
copy mode. A successful fresh Cournot installation prints the welcome message
from the installed SKILL.md; an overwrite or failed installation does not.`);
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
    `cournot-skills: failed to start the skills installer: ${result.error.message}`
  );
  process.exit(1);
}

const exitCode = result.status ?? 1;
const installerOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

if (shouldShowWelcome(installerOutput, exitCode)) {
  try {
    const installedPath = findInstalledSkillPath(installerOutput);
    const skillText = readFileSync(join(installedPath, "SKILL.md"), "utf8");
    console.log(`\n${extractWelcome(skillText)}\n`);
  } catch (error) {
    console.error(
      `cournot-skills: the skill was installed, but its welcome message could not be displayed: ${error.message}`
    );
    process.exit(1);
  }
}

process.exit(exitCode);
