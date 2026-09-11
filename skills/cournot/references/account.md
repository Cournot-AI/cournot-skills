# Credentials and account management

Use only `scripts/cournot-client.mjs` for these operations. No key goes in a URL, command argument, payment intent, error log, or generic API output. API keys and wallet secrets are different: a user may supply a Cournot key for import, but never request a wallet private key or seed phrase.

## Balance, key, import

```sh
node <skill-root>/scripts/cournot-client.mjs balance
node <skill-root>/scripts/cournot-client.mjs key
node <skill-root>/scripts/cournot-client.mjs import
```

`import` reads the key from **stdin**, not arguments. Use a tool's stdin channel or a hidden local terminal prompt. Do not construct `echo <key>` / inline shell commands containing the secret. If secure input is unavailable, ask the user to run the command locally and supply the key through stdin. Do not echo an imported key back into chat.

- `balance`: show balance and masked key. `/account` does not return the free allowance; do not promise that it does.
- `key`: this is the only explicit action allowed to reveal `api_key`. Include the client's secrecy warning. It calls `/account` to verify the key before displaying it.
- `import`: validate through `/account` before atomically replacing the saved key. Invalid keys preserve the old file. Accept KOL/manual keys, including those with no wallet. Import never rotates a key or buys a pack.
- `credential_missing`: ordinary queries still work anonymously. For an explicit `key` request, offer wallet recovery below; for balance, explain that no local key is configured and offer import or wallet recovery.
- `key_invalid`: likely invalid or rotated elsewhere; use another device's current key plus import, or wallet recovery. Do not automatically rotate.

Credentials are stored as `~/.cournot/credentials/<URL-encoded-origin>.json`, shared by agents running as the same OS user. Separate files isolate dev, production and local tests. `COURNOT_CREDENTIAL_DIR` may select a private storage directory, particularly for isolated tests. Unix directory/file modes are 700/600; on Windows ensure the user profile's ACL restricts access. Files are plaintext, not encrypted. `COURNOT_API_KEY` has priority only for its `COURNOT_API_KEY_BASE` (defaults to dev). The client never edits environment variables or host configuration files.

If a save returns `active=false`, explain that the environment variable still overrides the file. Do not claim the new key is active, expose either full key, or silently remove the override. Ask the user to update or unset it in the host environment.

## Recover an existing key with the wallet

The backend can return the current key through wallet authentication; losing the local file does not require rotation or another purchase.

```sh
node <skill-root>/scripts/cournot-client.mjs auth-prepare --action account
```

Add `--reveal true` **only** when fulfilling an explicit `/cournot key`. Omit it for purchase recovery and balance. Successful recovery saves the current key to the active environment's credentials file.

## Rotate

Only for suspected compromise or an explicit rotation request. Explain before execution: the old key immediately stops working on every device; the wallet balance remains unchanged. A second device should import, not rotate.

```sh
node <skill-root>/scripts/cournot-client.mjs auth-prepare --action rotate
```

Both actions use Binance Agentic Wallet's `sign-message` EIP-712 flow, with fixed domain `Cournot`, version `1`, chainId `1`, and `WalletAuth(urlPath:string, nonce:string, timestamp:string)`. The authentication chain id stays 1 even if the pack was purchased on BSC or Base. The client derives the wallet address from `baw wallet address` and never accesses private keys. Developer Mode must be enabled by the user in the Binance App.

## Signature confirmation and completion

Only a `state=complete` response from the corresponding `auth-execute` or `auth-status` establishes that the operation completed. A successful balance read does not prove rotation. Empty output or process exit code zero without JSON is not success: stop and report an unconfirmed operation rather than claiming that a key changed.

For `signature_confirmation_required`, show the destination environment, wallet, action, parsed message, and any returned risks or authority changes. For rotation explicitly mention invalidation of all other devices. Obtain confirmation before execution; a payment confirmation is not a rotation confirmation.

```sh
node <skill-root>/scripts/cournot-client.mjs auth-execute --intent '<intentId>' --confirmed true
```

- `signature_pending`: ask the user to confirm in the Binance App. Preserve the **new** returned intent id. Query it with `auth-status --intent '<intentId>'`; this retrieves the existing signature and does not sign again. Stop polling on rejected/expired results; do not loop automatically.
- `complete`: show balance, save status, and masked key, except the explicit `key` reveal. `hasKey=false` with zero balance means the wallet has no key record, not an authentication failure.
- `developer_mode_required`: ask the user to enable Developer Mode in the Binance App. Do not change wallet settings automatically.
- `wallet_required`: assist the selected Binance wallet's login; do not show a payment or funding prompt for authentication.
- `WALLET_351817`: wallet does not support the requested message; stop, do not substitute another signature scheme.
- `WALLET_351801`: Developer Mode is disabled. `WALLET_10003002`: session expired; sign in again. Other wallet errors: report the code without guessing a cause or changing wallets.
- `api_error` with `8000`: invalid/expired wallet authentication. `4400`: no key for the wallet. `22004`: manual key cannot self-rotate. Do not describe these as insufficient funds.
- `credential_save_failed`: funds/remaining calls are still owned by the wallet. Recover with wallet `/account`; do not buy or rotate again.
- `account_result_unknown`, HTTP 5xx or a connection failure during rotation: do not repeat rotate. Use a fresh **account** recovery to inspect the current key.

Wallet signatures and returned keys stay inside the client. No direct wallet signing or authenticated curl commands through the model.
