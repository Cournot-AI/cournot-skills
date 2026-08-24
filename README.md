# Cournot Skills

Cournot gives AI agents fair-value probability estimates for prediction markets, together with the venue's current price and the external data behind the assessment.

## Installation

Install the Cournot skill with its dedicated installer:

```bash
npx cournot-skill
```

The installer detects supported agents such as Codex and Claude Code and lets you choose where to install the skill. After a successful fresh installation, it prints the Cournot welcome message directly from the bundled `SKILL.md`. To install it globally without prompts for Codex:

```bash
npx cournot-skill --global --agent codex --yes
```

Prerequisite: Node.js 22.20 or newer with `npx` available.

The generic skills installer remains available as a fallback:

```bash
npx skills add Cournot-AI/cournot-skills/skills/cournot
```

The generic installer does not guarantee that an agent will display the post-install welcome message. Use `npx cournot-skill` when that handoff is required. The welcome copy lives only in `SKILL.md`, and the dedicated installer extracts it from there so the product copy has a single source of truth.

## Usage

Ask Cournot about a prediction-market event in plain language:

```text
/cournot will ETH outperform BTC this quarter
```

You can also explicitly ask your agent to use Cournot. If several markets match, Cournot shows the candidates and lets you choose before requesting a probability. Market resolution and disambiguation are free.

## What You Get

- Cournot's probability estimate
- The venue's current market price
- The external data sources behind the assessment

Cournot returns the answer, not its proprietary algorithm.

## Pricing

The first three calls each day are free. No setup or wallet is needed. After that, each call costs $0.01.

If Cournot cannot answer because no market matches or the inputs are too thin, it says so and you are not charged.

## Payments and Safety

After the free calls, the agent needs its own wallet capable of signing x402 payments on Base or b402 payments on BNB Chain.

If the agent does not have a compatible wallet, you can install one without leaving the conversation. For example, Binance Agentic Wallet supports x402 payment signing:

```bash
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

Other compatible x402 v2 wallets and signers are also supported. Installing or connecting a wallet is handled by the wallet's own skill and security flow; Cournot does not block that setup and does not need access to the wallet's secrets.

After the wallet is ready, the agent can return to the pending Cournot question without requiring you to re-enter it. Some hosts may require a one-time skill reload before a newly installed wallet skill becomes available.

Cournot never asks for a private key or seed phrase and never holds user funds. Never paste wallet secrets into a conversation. A wallet should keep credentials in its own secure storage and provide only the authorization needed for each payment.

## Repository Structure

The npm wrapper bundles the Cournot skill, invokes the pinned `skills` CLI with copy mode, and prints the welcome text only after a fresh successful installation.

```text
├── bin/
│   └── cournot-skill.mjs
├── lib/
│   └── welcome.mjs
├── skills/
│   └── cournot/
│       ├── SKILL.md
│       └── evals/
└── test/
    └── welcome.test.mjs
```

## Disclaimer

Cournot provides an assessment of prediction-market pricing, not investment advice. Users are responsible for evaluating the information and making their own decisions.
