import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

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

export function findInstalledSkillPath(
  installerOutput,
  cwd = process.cwd(),
  userHome = homedir()
) {
  const plainOutput = installerOutput.replace(ANSI_PATTERN, "");
  const candidates = [
    ...plainOutput.matchAll(
      /^\s*(?:│\s*)?→\s+(.+?)\s*(?:│\s*)?$/gm
    ),
  ].map((match) => match[1]);
  const installedPath = candidates.find(
    (candidate) => basename(candidate.replaceAll("\\", "/")) === "cournot"
  );

  if (!installedPath) {
    throw new Error("Could not locate the installed cournot skill directory.");
  }

  if (installedPath === "~") {
    return userHome;
  }

  if (installedPath.startsWith("~/") || installedPath.startsWith("~\\")) {
    return resolve(userHome, installedPath.slice(2));
  }

  return isAbsolute(installedPath)
    ? installedPath
    : resolve(cwd, installedPath);
}
