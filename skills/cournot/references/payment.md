# Payment flow

Read this reference only after a probability request returns HTTP 402.

Read `PAYMENT-REQUIRED` (any casing). Its value is base64 JSON. Decode it and inspect **every** `accepts[]` entry. This fresh header is the only source of truth for payment choices, original array indexes, schemes, networks, asset contracts, amounts, recipients, timeouts, signers, and EIP-712 metadata. Do not hard-code any of those values in the skill or payment implementation.

Do not inspect only `accepts[0]`, reject the entire response because one entry is unsupported, rewrite or reorder entries for API handling, or combine fields from different entries. Compare every returned entry with every available wallet or signer. Supporting every returned option means discovering, displaying, and considering them all during the initial payment-route presentation; after the user selects a wallet or signer branch, final confirmation follows only that branch. Sign and pay with exactly one user-selected option per probability call.

There is no network or array-position default. If more than one option is compatible, show all of them and ask the user which one to use. Preserve the original accept index. Never silently choose, substitute, or switch. Even when only one option is compatible, show its network, asset, amount, and recipient and obtain explicit confirmation before signing.

For user-facing payment-option tables, never display the raw `accepts[]` index or label a column `original index`. Assign simple 1-based display numbers after ordering and retain an internal mapping from each display number to its untouched original accept. Always place returned BNB Smart Chain options compatible with Binance Agentic Wallet first and mark the first one as recommended, regardless of whether that wallet is installed, connected, or authenticated; then show all remaining options in their server-returned relative order. This recommendation affects display order only and is never automatic selection or permission to sign.

Before signing, state whether the selected network is mainnet or testnet when the returned identifier makes that determinable. A mainnet payment transfers real assets.

## Binance Agentic Wallet

When the `binance-agentic-wallet` skill and `baw` CLI are available, use that skill for wallet preflight, authentication, preview, and signing. Cournot controls HTTP handling; the wallet controls access and authorization.

Treat an explicit user choice such as `Binance Agentic Wallet`, `连接 Binance 钱包`, or its equivalent as selection of the Binance Agentic Wallet payment branch. Preserve that branch across sign-in, verification, status checks, and the fresh 402 request. Do not ask the user to select a payment provider or unrelated network again after authentication succeeds.

Pass the complete, fresh, unmodified base64 requirements:

```sh
baw x402-payment preview --paymentRequirements '<PAYMENT-REQUIRED>' --json
```

Inspect every preview result and map it to the exact fresh accept. The complete preview remains internal. When the Binance branch is selected, retain its `READY_TO_SIGN` options whose network, asset, amount, and recipient match, but do not show preview entries for other networks or payment providers in the final confirmation. In particular, omit their `NOT_SIGNABLE`, `UNSUPPORTED_NETWORK`, and other irrelevant statuses instead of presenting them as contradictory choices.

If exactly one Binance option is `READY_TO_SIGN`, present a compact `Binance Agentic Wallet payment confirmation`, not an options table. Show only the wallet, network and mainnet/testnet status, asset with full contract address, human-readable amount, estimated USD value when available, balance when available, recipient, and any approval requirement. Ask for explicit payment confirmation without calling it `option 1` or repeating route selection. If multiple Binance options are `READY_TO_SIGN`, show only those Binance choices and ask which one to use. If none is ready, report exact blockers only for the Binance branch and offer to return to the initial route selection; do not display unrelated routes as fallbacks. After the user confirms, pass the matched preview's returned 1-based `options[].index` to `sign`; do not substitute an array offset:

```sh
baw x402-payment sign --paymentId <paymentId> --selectedIndex <index> --json
```

If `approveTxHash` is returned for the selected option, wait for confirmation as directed by the wallet skill. Never sign without confirmation or reuse a `paymentId` or signature for another 402.

Normalize the returned `paymentHeaderValue` to Cournot's flattened shape below, then put the new base64 value in `PAYMENT-SIGNATURE` on the original probability request. Do not rerun resolve or change its body.

If Binance Agentic Wallet is unavailable but another compatible signer is configured, consider every fresh accept and present every option that signer can use.

## No payment capability

If no compatible wallet or signer is available, stop before signing or retrying. Explain that free quota is exhausted and list every fresh option using the user-facing display numbers and ordering above, with its network, asset address or returned symbol, human-readable amount, and recipient. Keep original indexes internal.

Offer to install or connect a compatible wallet, or stop without paying. Do not automatically install software or create a wallet. If the fresh response contains a BSC option, include Binance Agentic Wallet as a recommended complete wallet for that option, but do not select BSC for the user or hide other options.

Always provide these concrete setup routes:

- Recommended agent wallet when compatible — Binance Agentic Wallet: `https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet`
- Official developer SDK — x402 Foundation Buyer Quickstart: `https://docs.x402.org/getting-started/quickstart-for-buyers`
- Recommended Node.js local signer — viem Local Accounts: `https://viem.sh/docs/accounts/local`

The x402 SDK handles the protocol but is not a wallet or signer. For Node.js development, pair it with `viem`; the dependency set is `@x402/core`, `@x402/fetch`, `@x402/evm`, and `viem`. `viem` signs locally but does not provide secure key custody, wallet funding, or secret management. It requires an existing key supplied outside the conversation, preferably through a secret manager or local environment variable. Never ask the user to paste a private key or seed phrase, put it in source, print it, commit it, or generate and persist a raw key automatically. For production funds, prefer a managed or isolated signer.

Ask whether the user wants to install Binance Agentic Wallet when compatible, set up the SDK with a local signer, connect another compatible wallet, or stop. Preserve the pending Cournot query. The standard Binance installation command may be shown or run only after an explicit installation request:

```sh
npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet
```

After a wallet becomes ready, do not sign a cached 402. Send the same probability JSON once without `PAYMENT-SIGNATURE` to obtain fresh requirements and preview the complete fresh payload internally. Preserve the wallet branch selected before authentication and render only that branch's final confirmation as specified above.

## Selected fields and signing

Copy the selected option's `scheme`, `network`, `asset`, `amount`, `payTo`, timeout, and every `extra` field from that same fresh accept. Do not compare them with constants or combine fields across accepts. The returned `payTo` is the receiver for that option, not the agent's wallet; show it during confirmation and never tell the user to deposit into it separately.

Use the signing method declared by the selected accept and supported by the selected wallet. For EIP-3009 `TransferWithAuthorization`, derive the chain id from the selected network, set `to` and `value` from the selected `payTo` and `amount`, use the selected asset as the verifying contract, and use the selected EIP-712 metadata. Never reuse a domain, address, amount, nonce, or signer from another option or earlier 402.

## `PAYMENT-SIGNATURE` shape

Official clients may return a nested envelope:

```json
{
  "x402Version": "<fresh requirements x402Version>",
  "payload": {"signature": "<wallet signature>", "authorization": {"from": "<wallet address>", "to": "<selected accept.payTo>", "value": "<selected accept.amount>", "validAfter": "0", "validBefore": "<unix seconds>", "nonce": "<unique nonce>"}},
  "resource": {"url": ""},
  "accepted": {"scheme": "<selected accept.scheme>", "network": "<selected accept.network>", "asset": "<selected accept.asset>", "amount": "<selected accept.amount>", "payTo": "<selected accept.payTo>"}
}
```

Cournot requires a flattened envelope:

```json
{
  "x402Version": "<fresh requirements x402Version>",
  "scheme": "<selected accept.scheme>",
  "network": "<selected accept.network>",
  "payload": {
    "signature": "<wallet signature>",
    "authorization": {"from": "<wallet address>", "to": "<selected accept.payTo>", "value": "<selected accept.amount>", "validAfter": "0", "validBefore": "<unix seconds>", "nonce": "<unique nonce>"}
  }
}
```

`scheme` and `network` must be top-level and must come from the selected accept. `to`, `value`, and the signed network must match it.

```js
function toCournotPayment(obj) {
  const accepted = obj.accepted || {};
  const x402Version = obj.x402Version;
  const scheme = obj.scheme || accepted.scheme;
  const network = obj.network || accepted.network;
  if (x402Version == null || !scheme || !network) {
    throw new Error("Fresh payment version, selected scheme, and selected network are required");
  }
  return { x402Version, scheme, network, payload: obj.payload };
}
```

Base64-encode minified JSON and send it as `PAYMENT-SIGNATURE`, not `X-PAYMENT`, `Authorization`, or another header. Retry the exact probability body once. Use one unique nonce per call; a reused signature may return `authorization is used or canceled`.
