#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
let staging;
let exitCode = 1;
try {
  let installSource = source;
  const localSource = resolve(source);
  if (existsSync(localSource) && statSync(localSource).isDirectory()) {
    // The upstream local copy does not honor .gitignore. Keep evaluation
    // scripts and raw logs out of both direct-skill and repository installs.
    staging = mkdtempSync(join(tmpdir(), "cournot-skills-install-"));
    installSource = join(staging, basename(localSource));
    const excluded = new Set(["evals", ".git", "node_modules", "__pycache__"]);
    cpSync(localSource, installSource, { recursive: true,
      filter: (path) => path === localSource || !excluded.has(basename(path)) });
  }
  const result = spawnSync(process.execPath,
    [skillsCli, "add", installSource, "--copy", ...forwardedOptions],
    { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} catch (error) {
  console.error(`cournot-skills: installation failed: ${error.message}`);
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
process.exit(exitCode);
