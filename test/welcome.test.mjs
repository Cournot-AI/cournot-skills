import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractWelcome,
  findInstalledSkillPath,
  shouldShowWelcome,
} from "../lib/welcome.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("extractWelcome reads the fenced welcome and replaces next_year", () => {
  const skill = `
## Post-install welcome (once)

Instructions that are not part of the welcome.

\`\`\`text
Welcome.
Try before <next_year>.
\`\`\`

## Next section
`;

  assert.equal(
    extractWelcome(skill, new Date(2026, 7, 24)),
    "Welcome.\nTry before 2027."
  );
});

test("extractWelcome fails when the source block is missing", () => {
  assert.throws(
    () => extractWelcome("# Cournot"),
    /Could not find the Post-install welcome/
  );
});

test("the repository SKILL.md contains the installer's welcome source", () => {
  const skill = readFileSync(
    join(packageRoot, "skills", "cournot", "SKILL.md"),
    "utf8"
  );
  const welcome = extractWelcome(skill, new Date(2026, 7, 24));

  assert.match(
    welcome,
    /^Cournot — fair-value probabilities for prediction markets\./
  );
  assert.match(welcome, /before 2027/);
  assert.doesNotMatch(welcome, /<next_year>/);
});

test("shouldShowWelcome accepts a fresh copied Cournot installation", () => {
  const output = `
Installed 1 skill
✓ cournot (copied)
`;

  assert.equal(shouldShowWelcome(output, 0), true);
});

test("shouldShowWelcome ignores ANSI escape sequences", () => {
  const output = "\u001b[32mInstalled 1 skill\u001b[0m\n✓ cournot (copied)";

  assert.equal(shouldShowWelcome(output, 0), true);
});

test("shouldShowWelcome rejects overwrites, failures, and non-install output", () => {
  assert.equal(
    shouldShowWelcome(
      "overwrites: Codex\nInstalled 1 skill\n✓ cournot (copied)",
      0
    ),
    false
  );
  assert.equal(
    shouldShowWelcome("Installed 1 skill\n✓ cournot (copied)", 1),
    false
  );
  assert.equal(shouldShowWelcome("Found 1 skill", 0), false);
});

test("findInstalledSkillPath resolves a project-local Cournot path", () => {
  const output = `
Installed 1 skill
  ✓ cournot (copied)
│    → ./.agents/skills/cournot  │
`;

  assert.equal(
    findInstalledSkillPath(output, "/tmp/example", "/home/example"),
    "/tmp/example/.agents/skills/cournot"
  );
});

test("findInstalledSkillPath expands a global Cournot path", () => {
  const output = `
Installed 1 skill
  ✓ cournot (copied)
│    → ~/.agents/skills/cournot  │
`;

  assert.equal(
    findInstalledSkillPath(output, "/tmp/example", "/home/example"),
    "/home/example/.agents/skills/cournot"
  );
});

test("findInstalledSkillPath rejects output without a Cournot install path", () => {
  assert.throws(
    () => findInstalledSkillPath("→ ./.agents/skills/another-skill"),
    /Could not locate the installed cournot skill directory/
  );
});
