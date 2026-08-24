import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findNewCournotSkillPaths,
  parseSkillList,
  renderWelcome,
} from "../lib/welcome.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("renderWelcome replaces next_year in the wrapper-owned template", () => {
  const welcome = renderWelcome(new Date(2026, 7, 24));

  assert.match(
    welcome,
    /^Cournot — fair-value probabilities for prediction markets\./
  );
  assert.match(welcome, /before 2027/);
  assert.doesNotMatch(welcome, /<next_year>/);
});

test("the skill fallback welcome matches the wrapper welcome", () => {
  const skill = readFileSync(
    join(packageRoot, "skills", "cournot", "SKILL.md"),
    "utf8"
  );
  const match = skill.match(
    /## Post-install welcome \(once\)[\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/
  );

  assert.ok(match, "SKILL.md must contain the fallback welcome block");
  assert.equal(
    match[1].replaceAll("<next_year>", "2027"),
    renderWelcome(new Date(2026, 7, 24))
  );
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
