export function extractWelcome(skillText, installationDate = new Date()) {
  const match = skillText.match(
    /## Post-install welcome \(once\)[\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/
  );

  if (!match) {
    throw new Error(
      "Could not find the Post-install welcome (once) text block in SKILL.md."
    );
  }

  return match[1].replaceAll(
    "<next_year>",
    String(installationDate.getFullYear() + 1)
  );
}

export function parseSkillList(output) {
  const skills = JSON.parse(output);

  if (!Array.isArray(skills)) {
    throw new Error("The skills list response was not an array.");
  }

  return skills;
}

export function findNewCournotSkillPaths(before, after) {
  const previousPaths = new Set(
    before
      .filter((skill) => skill?.name === "cournot" && skill?.path)
      .map((skill) => skill.path)
  );

  return after
    .filter(
      (skill) =>
        skill?.name === "cournot" &&
        skill?.path &&
        !previousPaths.has(skill.path)
    )
    .map((skill) => skill.path);
}
