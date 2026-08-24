---
name: cournot
description: Query Cournot prediction-market probabilities via POST /intelligence/v1/resolve then POST /intelligence/v1/probability, including x402 payment (reshape official x402 envelopes so Cournot accepts them). Use when the user runs /cournot, says to use Cournot, or asks Cournot for an event probability. Do not invoke on casual odds questions — probability is paid after free quota.
---

# Cournot

Query one event's probability from Cournot's two HTTP APIs. This skill is the HTTP + payment contract. Sign with whatever compatible wallet the runtime has (Coinbase AgentKit / CDP / `@x402/fetch` / MetaMask Agent Wallet / Binance Agentic Wallet / a local signer). Cournot itself never receives or stores wallet secrets. A user may install, connect, or configure a separate wallet skill when payment capability is missing; do not block that handoff.

Trigger only on an explicit Cournot ask (`/cournot …`, "use Cournot to look this up"). One paid `probability` call per user instruction. On a bad result, stop — do not retry with a rephrased query.

`message` is the user's event in their own words, not the command. After dropping `/cournot` and `probability`, if no claim remains (asset, threshold, or date), ask for one and stop — do not POST.

If they asked whether a market is mispriced or priced correctly: Cournot has no mispricing API. Say so and stop — do not POST.

Reply in the user's language. Templates below are English — same fields in Chinese when the user wrote Chinese. Ignore `/cournot` and API titles when detecting language.

Default base: `https://dev-interface.cournot.ai`

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
| {id} | {title} |

Reply with an id to query that market's probability. After the free quota is used up, payment is on-chain.
```

`code=4100` → show `msg`, stop.

## 2. Probability (3 free / IP / UTC day, then x402)

`POST {base}/intelligence/v1/probability`

```json
{"message": "<same user text>", "market_ids": [<1 to 10 ids>]}
```

Send only the chosen ids (often one). `message` still required.

Success `code=0`: use `data.probability`, `data.markets`, `data.basis[]` (`source`, `summary`, `time`), `data.charged`, `data.free_quota`, and `data.x402` when charged. `basis[]` is external data returned by the API, not a rationale to generate or supplement.

HTTP **402** + empty body → pay once (below) and retry the **same** JSON with `PAYMENT-SIGNATURE`. No second payment attempt on the same nonce.

`code=22000` → settlement failed. Generate a **new** nonce/signature if you retry. Same header will not work.

`code=4100` → show `msg`, stop.

## 3. Pay a 402

Read header `PAYMENT-REQUIRED` (any casing). Value is **base64 JSON**. Decode. That object is the source of truth for amount, asset, network, and payee.

### No payment capability

If the runtime has no compatible x402 wallet or signer, stop the paid request before signing or retrying. Explain that the free quota is exhausted and a compatible agent wallet or signer is needed for the $0.01 payment. Do not treat a missing wallet as a Cournot answer failure.

Do not automatically install software or create a wallet merely because a 402 was returned. Offer the user a choice: install/connect a compatible wallet, or stop without paying. Any x402 v2 client or wallet that supports the payment option returned by Cournot is acceptable.

One supported option is Binance Agentic Wallet, which provides x402 payment signing:

```bash
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

The official x402 Foundation TypeScript SDK is another option for runtimes that already have an EVM wallet or signer:

```bash
npm install @x402/core @x402/fetch @x402/evm viem
```

Documentation: `https://docs.x402.org/getting-started/quickstart-for-buyers`

When the user explicitly asks to install, connect, create, or configure a wallet, allow the appropriate installer or wallet skill to handle that workflow in the same conversation, subject to its own confirmations and security rules. This is not a request for Cournot to possess the wallet.

Preserve the unresolved Cournot query during the wallet handoff so the user does not need to type it again. If the host supports loading newly installed skills dynamically, continue in the same conversation. If it does not, explain that a one-time skill reload or new session is required; describe this as a host limitation, not a security refusal.

Never ask the user to paste a private key or seed phrase into the conversation. Do not reject a wallet installation merely because the wallet manages credentials securely outside Cournot. After the wallet is ready and the user authorizes payment, do not sign the earlier cached 402. First POST the same probability JSON again **without** `PAYMENT-SIGNATURE` to obtain a fresh 402, sign that new `PAYMENT-REQUIRED`, then retry the same JSON once with the new payment header.

If the selected payment option is Base Sepolia, the agent wallet needs test USDC from `https://faucet.circle.com/` on Base Sepolia. For a mainnet option, it needs the exact asset and network stated in `PAYMENT-REQUIRED`.

### Merchant (verify before signing)

`payTo` must be `0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68`. If `accepts[].payTo` differs, stop — do not sign.

This address is **Cournot's receiver**, not the agent's wallet. The agent pays **from** its own wallet **to** this address. Do not tell the user to deposit into `payTo`.

### Choose an `accepts[]` entry the wallet can sign

Prefer the first EVM `exact` entry the runtime supports. Typical **dev** (`dev-interface`):

| network | asset | amount | extra |
|---|---|---|---|
| `eip155:84532` Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` USDC | `10000` (= 0.01 USDC, 6 decimals) | EIP-712 name `USDC`, version `2` |
| `eip155:56` BSC | `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` USD1 | `10000000000000000` | name `USD1`, version `1` |

Prod 402 will list `eip155:8453` USDC instead of Sepolia. Always copy fields from the 402, not from this table.

Sign **EIP-3009** `TransferWithAuthorization` (`from`, `to`=`payTo`, `value`=`amount`, `validAfter`, `validBefore`, `nonce` unique 32 bytes). Domain: `extra.name`, `extra.version`, chain id from `network` (`eip155:84532` → 84532), `verifyingContract`=`asset`.

If the wallet has no USDC (or the listed asset) on that chain: say the **agent wallet** needs that test/mainnet token. Point at Circle faucet for Base Sepolia (`https://faucet.circle.com/`, network **Base Sepolia**) when on dev. Do not describe this as "Cournot cannot answer".

### Cournot `PAYMENT-SIGNATURE` shape (required)

Official x402 clients (`@x402/fetch`, AgentKit, CDP) often emit:

```json
{
  "x402Version": 2,
  "payload": { "signature": "0x…", "authorization": { "from": "0x…", "to": "0x…", "value": "10000", "validAfter": "0", "validBefore": "…", "nonce": "0x…" } },
  "resource": { "url": "" },
  "accepted": { "scheme": "exact", "network": "eip155:84532", "asset": "0x…", "amount": "10000", "payTo": "0x…" }
}
```

Cournot **rejects** that (`payment network not supported`). Flatten before sending:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:84532",
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0xAGENT",
      "to": "0xA8b2c2594eC5774479749d26105C9FB6CDcA1d68",
      "value": "10000",
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

Use only fields the API returned. Do not invent settlement sources, weights, per-source probabilities, or advice. When `basis[]` is non-empty, show every item in API order as a markdown table. Copy each `source`, `summary`, and `time` value verbatim from the API; do not translate, paraphrase, shorten, or supplement table cells. Escape `|` inside cell values and replace embedded newlines so the table remains valid. Always introduce the table as `External data basis:` in English or `外部数据依据：` in Chinese. If `basis[]` is empty, say no external basis data was returned.

```
The probability of {title} is {probability as percent}%.
Reference market: {title} ({market_outcome} {market_outcome_price as ¢}).

External data basis:

| source | summary | time |
|---|---|---|
| {source} | {summary} | {time} |

This query was {not charged / charged on-chain txn_hash} (free quota remaining/total). This is an assessment of pricing, not investment advice.
```

If charged, mention `x402.txn_hash` / `network_id`. If not, say not charged.

## Hosts

One `SKILL.md`. Claude Code, Codex, Grok, and other agents that load Agent Skills all use this file. Point the host at `skills/cournot/` (or copy the folder into its skills directory).
