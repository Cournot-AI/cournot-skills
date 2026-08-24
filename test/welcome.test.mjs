import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractWelcome,
  findNewCournotSkillPaths,
  parseSkillList,
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

test("parseSkillList accepts the skills CLI JSON output", () => {
  assert.deepEqual(parseSkillList('[{"name":"cournot","path":"/tmp/cournot"}]'), [
    { name: "cournot", path: "/tmp/cournot" },
  ]);
  assert.throws(() => parseSkillList("{}"), /was not an array/);
});

test("findNewCournotSkillPaths returns only newly installed paths", () => {
  const before = [
    { name: "cournot", path: "/repo/skills/cournot" },
    { name: "another", path: "/repo/skills/another" },
  ];
  const after = [
    ...before,
    { name: "cournot", path: "/repo/.agents/skills/cournot" },
    { name: "cournot", path: "/repo/.claude/skills/cournot" },
  ];

  assert.deepEqual(findNewCournotSkillPaths(before, after), [
    "/repo/.agents/skills/cournot",
    "/repo/.claude/skills/cournot",
  ]);
});

test("findNewCournotSkillPaths treats an overwrite as already installed", () => {
  const skills = [{ name: "cournot", path: "/repo/.agents/skills/cournot" }];

  assert.deepEqual(findNewCournotSkillPaths(skills, skills), []);
});
