# Customer-facing errors

Apply this guide to every error in both progress updates and final replies. Use the user's language and ordinary product wording: what happened to their request, what is known about payment/calls/credentials, and the next useful action. Always include a concrete next action or question, including for wallet blockers. Usually two or three short sentences suffice. Avoid repeating an error in several updates.

Do not print internal state names, error codes, raw server messages, HTTP statuses, JSON, intent/recovery IDs, file paths or implementation details in routine error replies. Preserve diagnostic fields internally for recovery. If the user explicitly requests troubleshooting or support details, provide relevant sanitized diagnostics separately; never expose secrets or signing payloads/parameters. Signing details remain internal even in troubleshooting. This does not hide required payment-preview fields, complete route `networkLabel` values (including CAIP and mainnet/testnet labels), public transaction hashes or a host-required approval explanation.

Base the explanation on the returned state and known mappings below. An HTTP success status alone does not establish business success. A server error is not evidence of timeout, insufficient funds, expiry, a refund or a chain failure. For unfamiliar errors, say the requested operation could not be confirmed and offer an appropriate next step; do not invent a cause or copy the raw reason. Never retry, pay, rotate, recover or switch wallet automatically because an error occurred.

| Internal result / evidence | Customer meaning and next step |
|---|---|
| `purchase_unknown`, including business `22000` / `invalid_transaction_state` | The pack has not been confirmed as credited and payment status remains uncertain. A returned settlement exception can be described as a payment-service error; do not call it a timeout without timeout evidence. To avoid duplicate payment, offer checking the paying wallet's account or recovering this same purchase with its original payment authorization. Recovery may complete the original payment; never promise it cannot charge. Keep the recovery ID internally. |
| `credential_save_failed` after a confirmed purchase | The calls were credited to the paying wallet, but its key could not be saved on this device. Offer wallet account recovery, not another purchase or rotation. |
| `payment_failed` | Payment could not be completed as requested. Explain a known returned reason in ordinary language. Do not infer that funds never moved from the state name alone. Stop; no new payment attempt. |
| `wallet_blocked` before signing | Explain only the returned blocker, identifying the affected wallet or payment route. Copy each returned `networkLabel` in full; a network identifier is route information, not an error code. No payment was executed; the pack was not purchased or the requested probability was not obtained. `INSUFFICIENT_BALANCE` means insufficient balance for that route. Unknown blockers mean the wallet could not complete that operation, not necessarily insufficient funds. Offer retry of the selected wallet operation, explicit wallet switch, or stop. |
| `key_invalid`, invalid key format | The key is not usable. Offer importing the current key or wallet account recovery. Do not suggest `/cournot key` for ordinary query recovery, since that explicitly reveals a full secret; offer account recovery without revealing the key. Do not claim it definitely expired or was rotated unless established. A rejected import leaves the existing saved key unchanged. |
| `rate_limited` | Requests are too frequent; ask the user to try later. Do not suggest buying calls or invent a retry time. |
| `service_error`, network/API failure during a query | The probability was not obtained. If usage is unconfirmed, say remaining calls may need checking and offer balance lookup. Do not guarantee no deduction or automatically repeat the query. |
| Invalid query arguments | Explain the known input issue and ask for corrected input. Do not mislabel it an invalid key merely because both use `4100`. |
| `WALLET_351817` | The wallet does not support this authentication message. Stop without substituting a signing scheme. |
| `developer_mode_required`, `WALLET_351801` | Ask the user to enable Developer Mode in the Binance App. |
| `WALLET_10003002` | The wallet session expired; offer signing in again. |
| Account `8000` / `4400` / `22004` | Respectively: wallet authentication is invalid or expired; no key is registered for this wallet; this manually issued key cannot be self-rotated. Explain only the returned case; none means insufficient funds. |
| `account_result_unknown` or failed connection during rotation | The key change is unconfirmed. Offer account recovery to inspect the current key; never repeat rotation. |

A balance lookup alone may not prove whether a particular purchase settled; keep that uncertainty if the account result cannot establish it.

## Troubleshooting: EIP-3009 authorization not yet valid

This is a conditional troubleshooting tip, not a required delay in the normal payment flow. Some Binance Wallet payments have encountered a short gap between the signed `validAfter` and the latest chain block timestamp. EIP-3009 requires `block.timestamp > validAfter`; equality is not enough.

`invalid_transaction_state` alone does not establish this cause. Confirm it with settlement diagnostics or an authorized internal inspection of the original authorization and chain timestamp. Do not infer that no transaction was broadcast or no funds moved merely from this error or a missing transaction hash. Keep signing data out of chat and tool output; do not manually decode or relay wallet credentials to troubleshoot.

When this cause is confirmed, waiting until the chain timestamp exceeds `validAfter` can allow the original authorization to succeed, provided it is still before `validBefore`. A roughly three-second buffer resolved an observed 1–2 second lag, but local elapsed time does not guarantee chain readiness. Do not prescribe a fixed sleep for every payment or treat waiting as a remedy for expired authorizations or unrelated settlement errors.

For packs, offer the existing explicitly confirmed same-purchase recovery in [payment.md](payment.md); preserve the original signature, nonce, amount and request. Recovery can complete the original charge. If the authorization has expired or the cause remains unresolved, offer account recovery/support instead of another payment. Per-call failures must stop under the existing payment rules; this tip does not introduce a per-call replay command or automatic retry.

Setting `validAfter=0` before signing avoids this start-time issue, but the checked Binance Wallet CLI 1.8.0 signing interface only accepts `paymentId` and `selectedIndex`. Do not invent an override parameter or modify the authorization after signing.
