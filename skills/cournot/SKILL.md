---
name: cournot
description: Query Cournot probabilities and manage prepaid calls, balances, and API keys. Use only for /cournot or an explicit request to use Cournot, not for casual odds questions.
metadata:
  openclaw:
    homepage: https://skill.cournot.ai/
    requires:
      bins:
        - node
    envVars:
      - name: COURNOT_CREDENTIAL_DIR
        required: false
        description: Optional private storage directory; defaults to ~/.cournot. Use an isolated directory for evaluations.
      - name: COURNOT_API_KEY
        required: false
        description: Optional key overriding the saved credentials for COURNOT_API_KEY_BASE; never required for anonymous use.
      - name: COURNOT_API_KEY_BASE
        required: false
        description: Origin that owns the environment key; defaults to dev-interface.cournot.ai. Set explicitly for production keys.
      - name: COURNOT_API_BASE
        required: false
        description: Optional API base override for testing; defaults to dev-interface.cournot.ai during development; use pro.cournot.ai explicitly for production.
      - name: COURNOT_EVAL_ID
        required: false
        description: Optional evaluation identifier used only with a non-production API base.
      - name: COURNOT_WALLET_COMMAND
        required: false
        description: Optional compatible wallet command; defaults to baw when a paid request requires a wallet.
      - name: COURNOT_INTENT_DIR
        required: false
        description: Optional directory for short-lived payment intent files; defaults to the operating system temporary directory.
---

# Cournot

Use only for `/cournot` or an explicit request to use Cournot. Reply in the user's language. The API supplies the assessment and evidence; never invent a second estimate.

## Route the request first

After removing `/cournot` and outer whitespace, match these complete commands. Do not interpret an event containing a reserved word as a management command.

| Input | Action / reference |
|---|---|
| `balance` | Read balance and masked key — [account.md](references/account.md) |
| `key` | Show the full key, or recover it using the wallet — [account.md](references/account.md) |
| `import <key>` | Validate and save an existing key — [account.md](references/account.md) |
| `rotate` | Confirm invalidation of all old-key devices, then rotate — [account.md](references/account.md) |
| `topup` | Let the user select a pack, preview and confirm payment — [payment.md](references/payment.md) |
| Anything else | Event query — [query-flow.md](references/query-flow.md) |

For event queries only, also strip the optional `probability` prefix. The message is the user's event in their own words. If no claim with an asset, threshold, or date remains, ask for one without calling the API. Cournot has no mispricing API; explain this and stop on a mispricing request.

## Runtime and billing

Node.js 22.20 or newer is required. All API operations use `scripts/cournot-client.mjs`; credentials and wallet signatures stay inside the client. The current default is **development**, `https://dev-interface.cournot.ai`. `COURNOT_API_BASE=https://pro.cournot.ai` selects production. Never silently change environments to work around a failure. Display the active environment for management and payment operations; dev payments can still transfer real mainnet assets.

Each IP has **three free probability calls in total, with no reset**. Free allowance is used before prepaid calls. No key or wallet is required to start. After free calls, a configured key spends prepaid balance; otherwise the user chooses topup, import, or $0.01 per-call payment. Packs do not expire, stack, and are non-refundable. Prices and call counts come from the client's pack catalog; actual payment terms come from the server's 402 response.

One user query permits one probability assessment, including free and prepaid calls. A confirmed 402 replay is part of that same assessment. No automatic retries, background queries, automatic topup, or silent fallback from prepaid balance to per-call payment. Keep pending event text and selected market ids through disambiguation, credential setup, and payment confirmation. A completed topup does not automatically rerun the pending query.

`COURNOT_API_KEY` overrides the file only for `COURNOT_API_KEY_BASE` (dev by default). Otherwise the client reads a per-origin file beneath `~/.cournot/credentials/`. Files are plaintext protected by filesystem permissions, not an encrypted vault. Never read or edit them through the model. Use client commands for import, saving, recovery, and display. Only explicit `/cournot key` may reveal a complete key; all other output must remain masked. Never request wallet private keys or seed phrases.

On a successful probability response, read [response-format.md](references/response-format.md). Report the returned billing route and remaining calls; `charged=false` does not mean no prepaid call was consumed. Never manufacture a missing quota, promise a daily reset, or promise no deduction after an uncertain server failure.

Claude Code, Codex, Grok, OpenClaw, and other Agent Skills hosts use this same folder. Install the entire `skills/cournot/` folder, including scripts and references.
