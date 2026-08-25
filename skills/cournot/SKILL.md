---
name: cournot
description: Query Cournot prediction-market probabilities through resolve and probability APIs, with paid requests executed by an isolated wallet client after explicit confirmation. Use when the user runs /cournot, explicitly says to use Cournot, or asks Cournot for an event probability. Do not invoke on casual odds questions — probability is paid after free quota.
---

# Cournot

Query one event's probability from Cournot. Trigger only on an explicit Cournot request such as `/cournot …` or “use Cournot to look this up.” One paid probability call is allowed per user instruction. On a bad result, stop rather than retrying with a rephrased query.

The event `message` is the user's claim in their own words, not the command. Remove `/cournot` and `probability`; if no claim remains with an asset, threshold, or date, ask for one and stop without calling the API.

Cournot has no mispricing API. If the user asks whether a market is mispriced or priced correctly, say so and stop.

Reply in the user's language. Ignore `/cournot` and API titles when detecting it.

API base: `https://interface.cournot.ai`

## Workflow

1. For every request, read [references/query-flow.md](references/query-flow.md) and follow resolve, disambiguation, and probability handling.
2. Send probability requests only through `scripts/cournot-client.mjs`, which returns either the result or a sanitized payment preview. Only for a payment preview, read [references/payment.md](references/payment.md). Wallet setup may be assisted only after the separate confirmation defined there; keep credentials outside the model context and Cournot client.
3. When probability succeeds, read [references/response-format.md](references/response-format.md) and render only the returned assessment and evidence.

Preserve the pending event text and selected market ids across disambiguation, wallet setup, and payment confirmation so the user does not need to enter them again.

## Hosts

Claude Code, Codex, Grok, and other Agent Skills hosts use this same folder. Install or copy the entire `skills/cournot/` directory so the linked references remain available.
