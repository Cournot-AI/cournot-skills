---
name: cournot
description: Query Cournot production prediction-market probabilities via POST /intelligence/v1/resolve then POST /intelligence/v1/probability, including BSC mainnet x402/b402 payment through Binance Agentic Wallet or another compatible signer. Use when the user runs /cournot, says to use Cournot, or asks Cournot for an event probability. Do not invoke on casual odds questions — probability is paid after free quota.
---

# Cournot

Query one event's probability from Cournot's two HTTP APIs. This skill is the HTTP + payment contract. For the production BSC/USD1 payment, prefer Binance Agentic Wallet's native x402 flow when its skill and `baw` CLI are available. Other compatible x402 wallets and signers remain supported; for Node.js local development, use `@x402/core` + `@x402/fetch` + `@x402/evm` with a `viem` Local Account signer. Cournot itself never receives or stores wallet secrets. A user may install, connect, or configure a separate wallet skill when payment capability is missing; do not block that handoff.

Trigger only on an explicit Cournot ask (`/cournot …`, "use Cournot to look this up"). One paid `probability` call per user instruction. On a bad result, stop — do not retry with a rephrased query.

`message` is the user's event in their own words, not the command. After dropping `/cournot` and `probability`, if no claim remains (asset, threshold, or date), ask for one and stop — do not POST.

If they asked whether a market is mispriced or priced correctly: Cournot has no mispricing API. Say so and stop — do not POST.

Reply in the user's language. Templates below are English — same fields in Chinese when the user wrote Chinese. Ignore `/cournot` and API titles when detecting language.

Production API base: `https://interface.cournot.ai`

## Market title display

Normalize every API-provided market `title` only when rendering it to the user, both in resolve candidate tables and probability results. Keep the original title and market id unchanged for API handling.

- Remove the phrase `at any time` and clean up the surrounding space.
- Render a timestamp written as `YYYY-MM-DD HH:MM UTC` as `Month D, YYYY`, using the English month name, no leading zero on the day, and no hour or timezone. Use the calendar date as written; do not convert it through the user's local timezone.
- Leave all other title wording unchanged.

Example: `Bitcoin price above $80,000 at any time before 2026-11-02 04:59 UTC` → `Bitcoin price above $80,000 before November 2, 2026`.

## Post-install welcome (once)

Immediately after this skill is installed successfully, display the following welcome message to the user exactly once. Before displaying it, replace `<next_year>` with the calendar year after the installation year (for example, an installation in 2026 renders `2027`). Preserve all other wording, capitalization, punctuation, and line breaks. Do not display it again on later Cournot invocations or ordinary skill updates.

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

## 1. Resolve (free)

`POST {base}/intelligence/v1/resolve`  
`Content-Type: application/json`

```json
{"message": "<user's event in their own words>", "limit": 5}
```

`message` is the event text (required). `limit` default 5, max 10.

Success: `code=0`, `data.markets[]` each with `matching_confidence` and `market_info` (`id`, `title`, `description`, `start_time`, `end_time`, `market_outcome`, `market_outcome_price`). `charged` is always false.

Empty `markets` → tell the user no market matched; suggest a more specific claim (asset, threshold, date). Stop.

If `markets[]` contains exactly one item, treat it as the resolved event and immediately call probability with that item's `market_info.id`. Do not list the item or ask the user to send its id, regardless of `matching_confidence`.

If `markets[]` contains multiple items, proceed to probability only when the user picked `id`s, or the leading market has confidence ≥ 0.85 **and** leads the next by ≥ 0.15. Those cutoffs stay internal.

For unresolved multiple-item results, list and wait. Do not pick for them. User-facing list is a **markdown table**, one row per market — not a wrapped bullet line, and no extra "closest market" commentary.

If the user selects more than 10 market ids, say that one probability request accepts at most 10 and ask them to choose up to 10. Do not POST an oversized `market_ids` array.

```
Related markets:

| id | title |
|---|---|
| {id} | {display-normalized title} |

Reply with an id to query that market's probability. After the free quota is used up, payment is on-chain.
```

`code=4100` → show `msg`, stop.

## 2. Probability (3 free / IP / UTC day, then x402)

`POST {base}/intelligence/v1/probability`

```json
{"message": "<same user text>", "market_ids": [<1 to 10 ids>]}
```

Send only the chosen ids (often one). `message` still required.

Success `code=0`: use `data.probability` and/or `data.result`, `data.markets`, `data.basis`, `data.charged`, `data.free_quota`, and `data.x402` when charged. If `data.probability` is itself an object containing `result` or `basis`, use those nested fields; otherwise use the sibling `data.result` and `data.basis` fields. Production `basis` is a structured object; older responses may return an array of `{source, summary, time}` instead. The API's `basis` is the related evidence for the assessment, not a rationale to replace, regenerate, or supplement.

Capture response headers on the first probability request (`curl -D -` or the runtime equivalent), because payment requirements arrive in a header. If that request returns HTTP **402** + empty body, pay once (below) and retry the **same** JSON with `PAYMENT-SIGNATURE`. Never send a second unsigned probability request merely to recover headers; no second payment attempt on the same nonce.

`code=22000` → settlement failed. Generate a **new** nonce/signature if you retry. Same header will not work.

`code=4100` → show `msg`, stop.

## 3. Pay a 402

Read header `PAYMENT-REQUIRED` (any casing). Value is **base64 JSON**. Decode. That object is the source of truth for amount, asset, network, and payee.

### Preferred flow: Binance Agentic Wallet

When the `binance-agentic-wallet` skill and `baw` CLI are available, use that skill for the wallet preflight, authentication, preview, and signing rules. Cournot controls the HTTP request and response handling; Binance Agentic Wallet controls wallet access and payment authorization.

The wallet command is named `x402-payment`; Cournot's backend routes the signed BSC payment through Binance B402 for verification and settlement. These are the buyer-side and merchant-side halves of the same payment flow, not competing protocols.

1. Pass the fresh, unmodified base64 `PAYMENT-REQUIRED` value to:

   ```sh
   baw x402-payment preview --paymentRequirements '<PAYMENT-REQUIRED>' --json
   ```

2. From the preview result, use only the option corresponding to Cournot's production `accepts[0]` below. It must be `READY_TO_SIGN`, and its original accept, network, token address, amount, and `payTo` must match the fresh 402. Pass the returned 1-based `options[].index` to `sign`; do not substitute an array offset. Do not silently switch networks, tokens, options, resources, or payees.
3. Show the user the human-readable token amount, USD value, BSC mainnet network, and recipient returned by preview. Obtain explicit confirmation before signing because this spends real mainnet USD1.
4. After confirmation, sign the exact previewed option:

   ```sh
   baw x402-payment sign --paymentId <paymentId> --selectedIndex <index> --json
   ```

5. Use the returned `paymentHeaderValue`, but normalize its decoded JSON to Cournot's flattened shape described below before replaying. Set the resulting base64 value as `PAYMENT-SIGNATURE` on the original probability request. Do not rerun resolve or change the probability body.

If preview returns `INSUFFICIENT_BALANCE`, explain that the wallet needs mainnet USD1 on BSC. For `NOT_SIGNABLE`, a security block, or a daily-limit block, stop and report the wallet's reason. If `approveTxHash` is returned, wait for confirmation as directed by the Binance wallet skill before replaying. Never call `sign` without confirmation, and never reuse a `paymentId` or signature for a different 402.

If Binance Agentic Wallet is unavailable but another compatible signer is already configured, use the generic EIP-3009 flow below. Do not install or create a wallet without the user's request.

### No payment capability

If the runtime has no compatible x402 wallet or signer, stop the paid request before signing or retrying. Explain that the free quota is exhausted and a compatible agent wallet or signer is needed for the payment amount and network stated by the 402. Do not treat a missing wallet as a Cournot answer failure.

Do not automatically install software or create a wallet merely because a 402 was returned. Offer the user a choice: install/connect a compatible wallet, or stop without paying. Any x402 v2 client or wallet that supports the payment option returned by Cournot is acceptable.

The reply must include concrete next steps; do not say only "install a compatible wallet." Always show all three official entries below, with equivalent labels in the user's language:

- Recommended agent wallet — Binance Agentic Wallet: `https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet`
- Official developer SDK — x402 Foundation Buyer Quickstart: `https://docs.x402.org/getting-started/quickstart-for-buyers`
- Recommended Node.js local signer — viem Local Accounts: `https://viem.sh/docs/accounts/local`

Explain that Binance Agentic Wallet is the recommended complete option for an agent that does not yet have a wallet. The x402 Foundation SDK handles the payment protocol but is not itself a wallet or signer. For Node.js development, recommend pairing that SDK with a `viem` Local Account signer; the complete dependency set is `@x402/core`, `@x402/fetch`, `@x402/evm`, and `viem`. `viem` signs locally but does not provide secure key custody, wallet funding, or secret management.

Treat `viem` as the recommended **local development signer**, not the universal production default. It needs an existing private key supplied outside the conversation, preferably through a secret manager or a local environment variable. Never ask the user to paste it, write it into source, print it, or commit it. Do not automatically generate or persist a raw private key merely because the SDK was installed. For production or valuable funds, prefer a managed/isolated agent wallet or signing service that supports EIP-712 `signTypedData` without exposing the raw key.

End the no-wallet reply by asking whether the user wants the agent to install the recommended agent wallet, set up the x402 SDK with the recommended local `viem` signer, connect another compatible wallet/signer, or stop without paying. Preserve the Cournot query for resumption. Include the warning not to paste a private key or seed phrase into the conversation.

When the user explicitly asks to install Binance Agentic Wallet, allow the appropriate installer or wallet skill to handle that workflow in the same conversation, subject to its own confirmations and security rules. The standard installation command is `npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`; show or run it only after that explicit request. This is not a request for Cournot to possess the wallet.

Preserve the unresolved Cournot query during the wallet handoff so the user does not need to type it again. If the host supports loading newly installed skills dynamically, continue in the same conversation. If it does not, explain that a one-time skill reload or new session is required; describe this as a host limitation, not a security refusal.

Never ask the user to paste a private key or seed phrase into the conversation. Do not reject a wallet installation merely because the wallet manages credentials securely outside Cournot. After the wallet is ready and the user authorizes payment, do not sign the earlier cached 402. First POST the same probability JSON again **without** `PAYMENT-SIGNATURE` to obtain a fresh 402, sign that new `PAYMENT-REQUIRED`, then retry the same JSON once with the new payment header.

This skill uses production mainnet payments. Before signing, make clear that the payment transfers real assets. The agent wallet needs the exact mainnet asset on the network stated in the fresh `PAYMENT-REQUIRED`; testnet tokens and faucets do not apply.

### Merchant (verify before signing)

`payTo` must be `0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68`. If `accepts[].payTo` differs, stop — do not sign.

This address is **Cournot's receiver**, not the agent's wallet. The agent pays **from** its own wallet **to** this address. Do not tell the user to deposit into `payTo`.

### Use the production `accepts[0]`

Follow `internal/common/x402/signature_test.go`: use the first `accepts[]` entry. The current production signing fixture is:

| field | required value |
|---|---|
| scheme | `exact` |
| network | `eip155:56` (BNB Smart Chain mainnet) |
| asset | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` (USD1) |
| amount | `10000000000000000` (= 0.01 USD1, 18 decimals) |
| payTo | `0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68` |
| maxTimeoutSeconds | `300` |
| EIP-712 name | `World Liberty Financial USD` |
| EIP-712 version | `1` |
| assetTransferMethod | `eip3009` |
| signerAddress | `0x34F7a661160780Ce1346e6D7B96D2bE244590899` |

The fresh 402 remains the source of truth. Verify that its first accept matches these production values; if network, asset, amount, payee, name, version, transfer method, or signer address differs, stop rather than signing a different payment.

Sign **EIP-3009** `TransferWithAuthorization` (`from`, `to`=`payTo`, `value`=`amount`, `validAfter`, `validBefore`, `nonce` unique 32 bytes). Domain: name `World Liberty Financial USD`, version `1`, chain id `56`, `verifyingContract`=`0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d`.

If the wallet has no USD1 on BNB Smart Chain mainnet, say the **agent wallet** needs mainnet USD1. Do not suggest test tokens or a faucet, and do not describe this as "Cournot cannot answer".

### Cournot `PAYMENT-SIGNATURE` shape (required)

Binance Agentic Wallet and other official x402 clients may return the standard nested envelope:

```json
{
  "x402Version": 2,
  "payload": { "signature": "0x…", "authorization": { "from": "0x…", "to": "0x…", "value": "10000000000000000", "validAfter": "0", "validBefore": "…", "nonce": "0x…" } },
  "resource": { "url": "" },
  "accepted": { "scheme": "exact", "network": "eip155:56", "asset": "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", "amount": "10000000000000000", "payTo": "0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68" }
}
```

Cournot **rejects** that (`payment network not supported`). Flatten before sending:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:56",
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0xAGENT",
      "to": "0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68",
      "value": "10000000000000000",
      "validAfter": "0",
      "validBefore": "<unix seconds>",
      "nonce": "0x<32-byte hex>"
    }
  }
}
```

`scheme` and `network` are **top-level**. Do not leave them only under `accepted`. `to` / `value` / `network` must match the chosen accept. `signature` may include `0x`.

```js
function toCournotPayment(obj) {
  const a = obj.accepted || {};
  return {
    x402Version: obj.x402Version ?? 2,
    scheme: obj.scheme || a.scheme || "exact",
    network: obj.network || a.network,
    payload: obj.payload,
  };
}
```

Base64-encode the **minified JSON**, send as request header **`PAYMENT-SIGNATURE`** (not `X-PAYMENT`, not `Authorization`). Retry the same `probability` body once.

One nonce per call. Reusing a signature returns `authorization is used or canceled`.

## 4. Recite (fixed)

Use only fields the API returned. Do not browse for more evidence, produce a separate subjective estimate, or invent settlement sources, weights, scenarios, per-source probabilities, links, or advice. In particular, never replace Cournot's response with wording such as "my subjective probability." The API result is the answer.

If `result` is present, use its returned fields for the assessment summary. Prefer `result.point_estimate` for the headline estimate; do not derive a different estimate from `basis`. Display all returned `result` fields in one markdown table, with only the columns actually returned. Render probability decimals as percentages while preserving their exact meaning: `0.035` → `3.5%`, `[0.02, 0.06]` → `2%–6%`. Leave enum strings such as `unlikely` unchanged.

Whenever `basis` is present and non-empty, displaying it is mandatory. Introduce it as `External data basis:` in English or `外部数据依据：` in Chinese, then render every returned field in API order as markdown tables. Do not omit a section or move its content into prose. Include only fields the API returned; do not fill absent template columns with invented values. Field names may remain as API keys; copy string values verbatim without translating, paraphrasing, shortening, or supplementing them. Escape `|` inside cells and replace embedded newlines so every table remains valid.

For the production structured object, render each present section separately:

- `primary_anchor`: one table with its returned keys as columns and one row of values.
- `price_distance`: one table with its returned keys as columns and one row of values.
- `cross_checks`: one table with the union of returned item keys as columns and one row per item, preserving array order.
- `limitations`: a one-column `limitation` table with one row per item, preserving array order.

Format probability and return decimals with their percentage equivalents, and USD fields with readable separators, without changing the underlying value. For example, `displayed_probability: 0.03` renders as `3%`, `required_return: 0.8993` as `89.93%`, and `volume_usd: 2813626` as `$2,813,626`. Do not interpret a price target as a probability.

The schema may gain additional `basis` sections or fields. Never drop them: render an unrecognized array of objects as a table using the union of its keys; render an unrecognized scalar array as a one-column table; render any other nested object as a `path | value` table with one row per scalar leaf.

For an older non-empty `basis[]`, show every item in API order in the legacy `source | summary | time` table, copying those values verbatim. If `basis` is absent, null, an empty object, or an empty array, say no external basis data was returned.

```
The probability of {display-normalized title} is {point_estimate or probability as percent}%.
Reference market: {display-normalized title} ({market_outcome} {market_outcome_price as ¢}).

Cournot assessment:

| market_implied_probability | defensible_range | point_estimate | verdict |
|---|---|---|---|
| {market_implied_probability} | {defensible_range} | {point_estimate} | {verdict} |

External data basis:

Primary anchor:

| type | source | event | displayed_probability | yes_ask | volume_usd | reason |
|---|---|---|---|---|---|---|
| {type} | {source} | {event} | {displayed_probability} | {yes_ask} | {volume_usd} | {reason} |

Price distance:

| btc_spot | target | days_remaining | required_return |
|---|---|---|---|
| {btc_spot} | {target} | {days_remaining} | {required_return} |

Cross-checks:

| source | year_end_target | signal |
|---|---|---|
| {source} | {year_end_target} | {signal} |

Limitations:

| limitation |
|---|
| {limitation} |

This query was {not charged / charged on-chain txn_hash} (free quota remaining/total). This is an assessment of pricing, not investment advice.
```

If charged, mention `x402.txn_hash` / `network_id`. If not, say not charged.

## Hosts

One `SKILL.md`. Claude Code, Codex, Grok, and other agents that load Agent Skills all use this file. Point the host at `skills/cournot/` (or copy the folder into its skills directory).
