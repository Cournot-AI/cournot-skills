const welcomeTemplate = `Cournot — fair-value probabilities for prediction markets.
HOW TO USE
  /cournot <event>
    · will BTC set a new all-time high before <next_year>
    · will ETH outperform BTC this quarter
    · will the Fed cut rates at its next meeting
  Ask in plain language. If more than one market matches,
  we'll show you the candidates and let you pick, free of charge.
WHAT YOU GET
  Our own probability estimate, the venue's current price, and the data
  sources behind it. Not the algorithm — the answer.
PRICING
  First 3 calls each day are free. No setup, no wallet.
  After that, $0.01 per call.
  If we can't answer — no matching market, or inputs too thin — we say so,
  and you are not charged.
PAYING
  Past the free calls, your agent needs its own wallet that can sign
  x402 (Base) or b402 (BNB Chain) payments. Each call is a $0.01 signed
  payment from that wallet.
  We never ask for your private key or seed phrase, and never hold funds.
Try one now — the first three are on us.`;

export function renderWelcome(installationDate = new Date()) {
  return welcomeTemplate.replaceAll(
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
