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
        description: Optional caller-configured private storage directory; defaults to ~/.cournot. Preserve its supplied value unchanged.
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

## Customer replies

Start routine requests with one short task-focused update in the user's language. For English use “Checking Cournot.” / “Checking Cournot packs.” / “Checking your account.” For Chinese use “正在查询 Cournot。” / “正在查看充值套餐。” / “正在查看账户。” Never use the Chinese examples for an English request. Use a neutral “Checking your Cournot request.” / “正在处理 Cournot 请求。” if input still needs validation. For `import`, use “Importing your Cournot key.” / “正在导入 Cournot 密钥。”; for `rotate`, use “Preparing key rotation.” / “正在准备密钥轮换。” Do not call an import or rotation a probability query. Once a result or next choice is available, present it immediately; do not add an update saying you will display the packs, organize the result, or prepare the final wording. After a command succeeds, render its result directly; do not repeat an account read, import or other completed operation just to verify the same result again. Then show the result, actual blocker or next choice. Do not promise a purchase or a result before it succeeds. Do not repeat a second setup update just because another reference or command is needed.

Keep internal work out of every customer message: no narration of reading skills/references, checking billing/validation rules, routing, encoding, command repair, confidence cutoffs, test fixtures or simulated input. Reference lookups and routine mechanical corrections do not need announcements. When an operation takes long enough to need an update, say only what is still pending for the user. Never speak as the user or invent their choice or confirmation. In Chinese use “最新付款预览”, not “新鲜支付预览”; use “密钥” and “次” for keys and call balances. Translate key rotation as “轮换密钥”, never “旋转密钥”.

Keep API market titles out of progress messages. In candidate tables and result headlines, apply only the title substitutions in query-flow.md; do not translate or paraphrase the remaining wording. This preserves conditions such as “above” and “before”.

In every payment preview and account result, include the active API environment and a clickable origin link, even if it appeared earlier. Determine it from the client's `base` (or the configured API base when absent): `https://dev-interface.cournot.ai` is development, `https://pro.cournot.ai` is production, and other origins are local/custom. The API environment and payment network are separate facts; a mainnet route does not imply the production API.

Treat routine choices as input collection, separate from payment or credential authorization. Put the next question in the final response when awaiting input. Quote internal rules or paths only if the user asks or the host requires it. For errors or uncertain outcomes, read [errors.md](references/errors.md) without announcing the lookup; apply it to progress updates and final replies.

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
