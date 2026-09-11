# Cournot Skills

[Website](https://skill.cournot.ai/) · [Skill source](skills/cournot/)

Cournot gives AI agents fair-value probability estimates for prediction markets, together with the venue's current price and the external data behind the assessment.

## Installation

Install the Cournot skill with its dedicated installer:

```bash
npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot
```

The installer detects supported agents such as Codex and Claude Code and lets you choose where to install the skill. To install it globally without prompts for Codex:

```bash
npx cournot-skills add Cournot-AI/cournot-skills/skills/cournot --global --agent codex --yes
```

Prerequisite: Node.js 22.20 or newer with `npx` available.

The generic skills installer remains available as a fallback:

```bash
npx skills add Cournot-AI/cournot-skills/skills/cournot
```

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

## Runtime Access

Requires Node.js 22.20 or newer. During development the default API is `https://dev-interface.cournot.ai`; explicitly set `COURNOT_API_BASE=https://pro.cournot.ai` for production. All calls use the bundled client.

No key or wallet is needed to start. Keys are stored in a user-level, per-origin file under `~/.cournot/credentials/`, shared across agents on the same OS account. These are plaintext files protected by filesystem permissions, not an encrypted vault. `COURNOT_API_KEY` can override the file for `COURNOT_API_KEY_BASE` (dev by default); set the key's base explicitly for production. Never put credentials in the project or commit them.

## Pricing and account commands

Each IP gets three free probability calls **in total**, with no reset. Free calls are used before prepaid calls. Once exhausted, choose a pack, import an existing key, or explicitly approve a $0.01 per-call payment. No automatic topup or payment fallback.

| Pack | List price | Calls |
|---|---|---|
| Starter | $5 | 600 |
| Standard | $20 | 2,800 |
| Scale | $50 | 8,000 |

Prepaid calls stack, never expire and are non-refundable. Dev packs currently charge $0.01; the payment preview is authoritative and may still use real mainnet assets. Catalog changes require updating the skill.

```text
/cournot balance
/cournot key
/cournot import <key>
/cournot topup
/cournot rotate
```

Balance and normal results show masked keys; only `key` reveals the complete secret. Import verifies the key before replacing the saved file. Keys are shared across devices; rotation immediately invalidates the old key everywhere while retaining the wallet's balance. Recover a lost local key using wallet authentication, without rotating or purchasing again. Losing both wallet access and key prevents recovery.

Wallet account recovery and rotation use EIP-712 authentication through Binance Agentic Wallet with Developer Mode enabled. The client previews the message for confirmation and keeps signatures out of model output. A configured key can query account balance without a wallet.

Billing output distinguishes free allowance, prepaid consumption and on-chain payment. Missing quota information is not treated as zero. Requests are not automatically retried after a failure, because the billing outcome can be uncertain.

## Payments and Safety

Buying a pack or choosing per-call payment requires a wallet capable of signing x402 payments on Base or b402 payments on BNB Chain. Using an existing key does not require a wallet.

If the agent does not have a compatible wallet, you can install one without leaving the conversation. For example, Binance Agentic Wallet supports x402 payment signing:

```bash
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

Other compatible x402 v2 wallets and signers are also supported. Installing or connecting a wallet is handled by the wallet's own skill and security flow; Cournot does not block that setup and does not need access to the wallet's secrets.

After the wallet is ready, the agent can return to the pending Cournot question without requiring you to re-enter it. Some hosts may require a one-time skill reload before a newly installed wallet skill becomes available.

Cournot never asks for a private key or seed phrase and never holds user funds. Never paste wallet secrets into a conversation. A wallet should keep credentials in its own secure storage and provide only the authorization needed for each payment.

Paid probability requests run through the bundled Cournot client. It keeps the wallet authorization and paid HTTP replay outside the model context; the agent receives only a sanitized payment preview before confirmation and the final Cournot response afterward.

## Repository Structure

The npm wrapper invokes the pinned `skills` CLI with copy mode.

```text
├── bin/
│   └── cournot-skills.mjs
├── skills/
│   └── cournot/
│       ├── SKILL.md
│       ├── scripts/
│       │   ├── cournot-client.mjs
│       │   ├── payment-flow.mjs
│       │   └── account-flow.mjs
│       └── references/
│           ├── account.md
│           ├── payment.md
│           ├── query-flow.md
│           └── response-format.md
└── tests/
    └── account-flow.test.mjs
```

## Disclaimer

Cournot provides an assessment of prediction-market pricing, not investment advice. Users are responsible for evaluating the information and making their own decisions.
