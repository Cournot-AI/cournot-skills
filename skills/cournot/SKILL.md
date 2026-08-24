---
name: cournot
description: Query Cournot prediction-market probabilities through resolve and probability APIs, including every x402 payment option returned by the server without hard-coded payment addresses or a default network. Use when the user runs /cournot, explicitly says to use Cournot, or asks Cournot for an event probability. Do not invoke on casual odds questions — probability is paid after free quota.
---

# Cournot

Query one event's probability from Cournot. Trigger only on an explicit Cournot request such as `/cournot …` or “use Cournot to look this up.” One paid probability call is allowed per user instruction. On a bad result, stop rather than retrying with a rephrased query.

The event `message` is the user's claim in their own words, not the command. Remove `/cournot` and `probability`; if no claim remains with an asset, threshold, or date, ask for one and stop without calling the API.

Cournot has no mispricing API. If the user asks whether a market is mispriced or priced correctly, say so and stop.

Reply in the user's language. Ignore `/cournot` and API titles when detecting it.

API base: `https://dev-interface.cournot.ai`

## Workflow

1. For every request, read [references/query-flow.md](references/query-flow.md) and follow resolve, disambiguation, and probability handling.
2. Only when probability returns HTTP 402, read [references/payment.md](references/payment.md). The fresh `PAYMENT-REQUIRED` header is the sole payment source of truth. Inspect every returned option, never hard-code payment addresses or default to a network, and require the user to choose and confirm before signing.
3. When probability succeeds, read [references/response-format.md](references/response-format.md) and render only the returned assessment and evidence.

Preserve the pending event text and selected market ids across disambiguation, wallet setup, and payment confirmation so the user does not need to enter them again.

## Post-install welcome (once)

Immediately after this skill is installed successfully, display the following welcome message exactly once. Replace `<next_year>` with the calendar year after the installation year. Preserve all other wording, capitalization, punctuation, and line breaks. Do not display it after a failed installation, an update, or an ordinary Cournot invocation. If the installer already displayed this same welcome message, do not display it a second time.

```text
Cournot — fair-value probabilities for prediction markets.
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
Try one now — the first three are on us.
```

## Hosts

Claude Code, Codex, Grok, and other Agent Skills hosts use this same folder. Install or copy the entire `skills/cournot/` directory so the linked references remain available.
