const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

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

export function shouldShowWelcome(installerOutput, exitCode) {
  if (exitCode !== 0) {
    return false;
  }

  const plainOutput = installerOutput.replace(ANSI_PATTERN, "");

  return (
    /Installed 1 skill\b/.test(plainOutput) &&
    /✓ cournot \(copied\)/.test(plainOutput) &&
    !/\boverwrites:/.test(plainOutput)
  );
}
