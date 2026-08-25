#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPaymentHeader,
  enumeratePaymentOptions,
  parsePaymentRequirements,
} from "./payment-flow.mjs";

const PRODUCTION_API_BASE = "https://interface.cournot.ai";
const INTENT_TTL_MS = 30 * 60 * 1000;
const APPROVAL_WAIT_MS = 45 * 1000;
const APPROVAL_POLL_MS = 3 * 1000;

const NETWORK_METADATA = {
  "eip155:8453": { name: "Base mainnet", environment: "mainnet" },
  "eip155:84532": { name: "Base Sepolia", environment: "testnet" },
  "eip155:56": { name: "BNB Smart Chain mainnet", environment: "mainnet" },
};

const TOKEN_METADATA = new Map(
  [
    ["eip155:8453", "USDC", 6],
    ["eip155:84532", "USDC", 6],
    ["eip155:56", "USD1", 18],
  ].map(([network, symbol, decimals]) => [
    `${network}:${symbol}`,
    { symbol, decimals },
  ])
);

const WALLET_SETUP_OPTIONS = [
  {
    id: "binance-agentic-wallet",
    name: "Binance Agentic Wallet",
    recommended: true,
    url: "https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet",
  },
  {
    id: "x402-buyer-quickstart",
    name: "x402 Foundation Buyer Quickstart",
    recommended: false,
    url: "https://docs.x402.org/getting-started/quickstart-for-buyers",
  },
  {
    id: "viem-local-accounts",
    name: "viem Local Accounts",
    recommended: false,
    url: "https://viem.sh/docs/accounts/local",
  },
];

function fail(message, code = "INVALID_INPUT") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left, right) {
  const a = String(left);
  const b = String(right);
  if (/^0x[0-9a-f]+$/i.test(a) && /^0x[0-9a-f]+$/i.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!isObject(value)) return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(paymentHeaderValue|signature|nonce|authorization|sessionToken|privateKey|seedPhrase)$/i.test(
        key
      )
    ) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSensitive(item);
    }
  }
  return output;
}

function formatBasisTimestamp(value) {
  if (typeof value !== "string") return value;
  return value.replace(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
    (match) => {
      const timestamp = new Date(match);
      return Number.isNaN(timestamp.getTime())
        ? match
        : `${timestamp.toISOString().slice(0, 19).replace("T", " ")} UTC`;
    }
  );
}

function normalizeBasisTimestamps(value) {
  if (Array.isArray(value)) return value.map(normalizeBasisTimestamps);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeBasisTimestamps(item),
      ])
    );
  }
  return formatBasisTimestamp(value);
}

function basisLink(label, value) {
  if (typeof label !== "string" || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const safeLabel = label.replace(/[\\[\]|]/g, "\\$&");
    return `[${safeLabel}](<${url.href}>)`;
  } catch {
    return null;
  }
}

function embedBasisLinks(value) {
  if (Array.isArray(value)) return value.map(embedBasisLinks);
  if (!isObject(value)) return value;

  const output = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, embedBasisLinks(item)])
  );
  if (!("url" in output)) return output;

  const url = output.url;
  delete output.url;
  if (typeof output.summary === "string") {
    let linked = false;
    output.summary = output.summary.replace(/"([^"\n]+)"/, (match, label) => {
      const link = basisLink(label, url);
      if (!link) return match;
      linked = true;
      return `"${link}"`;
    });
    if (linked) return output;
  }
  const summaryLink = basisLink(output.summary, url);
  if (summaryLink) output.summary = summaryLink;
  return output;
}

function normalizeResponseForDisplay(response) {
  if (!isObject(response)) return response;
  const output = structuredClone(response);
  const data = output.data;
  if (!isObject(data)) return output;
  if (data.basis != null) {
    data.basis = embedBasisLinks(normalizeBasisTimestamps(data.basis));
  }
  if (isObject(data.probability) && data.probability.basis != null) {
    data.probability.basis = embedBasisLinks(
      normalizeBasisTimestamps(data.probability.basis)
    );
  }
  if (isObject(data.free_quota)) {
    delete data.free_quota.ip;
  }
  return output;
}

function validateProbabilityRequest(request) {
  if (!isObject(request)) fail("Probability request must be an object");
  if (typeof request.message !== "string" || request.message.trim() === "") {
    fail("Probability request message is required");
  }
  if (
    !Array.isArray(request.market_ids) ||
    request.market_ids.length === 0 ||
    request.market_ids.length > 10
  ) {
    fail("Probability request must contain 1 to 10 market_ids");
  }
  return structuredClone(request);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    fail("Cournot returned a non-JSON response", "INVALID_API_RESPONSE");
  }
}

async function postProbability(fetchImpl, request, paymentHeader) {
  const headers = { "content-type": "application/json" };
  if (paymentHeader) headers["PAYMENT-SIGNATURE"] = paymentHeader;
  const testBase = process.env.COURNOT_API_BASE;
  const apiBase =
    testBase && /^http:\/\/127\.0\.0\.1:\d+$/.test(testBase)
      ? testBase
      : PRODUCTION_API_BASE;
  if (apiBase !== PRODUCTION_API_BASE && process.env.COURNOT_EVAL_ID) {
    headers["X-Eval-Id"] = process.env.COURNOT_EVAL_ID;
  }
  const response = await fetchImpl(`${apiBase}/intelligence/v1/probability`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  return {
    status: response.status,
    body: await readJsonResponse(response),
    paymentRequired: response.headers.get("payment-required"),
  };
}

function runBaw(args) {
  const walletCommand = process.env.COURNOT_WALLET_COMMAND || "baw";
  const result = spawnSync(walletCommand, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (result.error?.code === "ENOENT") {
    fail("Binance Agentic Wallet CLI is not installed", "WALLET_UNAVAILABLE");
  }
  if (result.error || result.status !== 0) {
    fail("Binance Agentic Wallet command failed", "WALLET_COMMAND_FAILED");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("Binance Agentic Wallet returned invalid JSON", "WALLET_INVALID_RESPONSE");
  }
}

export function createBinanceWalletRunner({
  run = runBaw,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
} = {}) {
  return {
    preflight() {
      const cli = run(["cli-check", "--required-version", "1.8.0"]);
      if (cli?.success !== true || cli?.data?.needUpdateCli === true) {
        fail(
          "Binance Agentic Wallet CLI 1.8.0 or newer is required",
          "WALLET_UPDATE_REQUIRED"
        );
      }
      const status = run(["wallet", "status"]);
      return {
        connected:
          status?.success === true && status?.data?.status === "CONNECTED",
        status: status?.data?.status ?? "UNKNOWN",
      };
    },
    preview(paymentRequired) {
      return run([
        "x402-payment",
        "preview",
        "--paymentRequirements",
        paymentRequired,
      ]);
    },
    sign(paymentId, selectedIndex) {
      return run([
        "x402-payment",
        "sign",
        "--paymentId",
        paymentId,
        "--selectedIndex",
        String(selectedIndex),
      ]);
    },
    async waitForApproval(txHash, binanceChainId) {
      const deadline = now() + APPROVAL_WAIT_MS;
      while (now() < deadline) {
        const result = run([
          "wallet",
          "tx-history",
          "--tx",
          txHash,
          ...(binanceChainId
            ? ["--binanceChainId", String(binanceChainId)]
            : []),
        ]);
        const transactions = result?.data?.transactions;
        if (
          result?.success === true &&
          Array.isArray(transactions) &&
          transactions.some(
            (transaction) =>
              sameValue(transaction.txHash, txHash) &&
              String(transaction.status).toLowerCase() === "confirmed"
          )
        ) {
          return true;
        }
        await wait(APPROVAL_POLL_MS);
      }
      return false;
    },
  };
}

function defaultIntentDirectory() {
  return process.env.COURNOT_INTENT_DIR || join(tmpdir(), "cournot-intents");
}

export function createFileIntentStore({
  directory = defaultIntentDirectory(),
  now = () => Date.now(),
  createId = randomUUID,
} = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  function assertIntentId(intentId) {
    if (!/^[0-9a-f-]{36}$/i.test(intentId || "")) {
      fail("Invalid payment intent id");
    }
  }

  return {
    save(value) {
      const intentId = createId();
      const path = join(directory, `${intentId}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          ...structuredClone(value),
          createdAt: now(),
          expiresAt: now() + INTENT_TTL_MS,
        }),
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      return intentId;
    },
    take(intentId) {
      assertIntentId(intentId);
      const path = join(directory, `${intentId}.json`);
      const processingPath = join(directory, `${intentId}.processing`);
      try {
        renameSync(path, processingPath);
      } catch {
        fail("Payment intent is missing or already used", "INTENT_UNAVAILABLE");
      }
      let value;
      try {
        value = JSON.parse(readFileSync(processingPath, "utf8"));
      } catch {
        unlinkSync(processingPath);
        fail("Payment intent is invalid", "INTENT_INVALID");
      }
      if (value.expiresAt <= now()) {
        unlinkSync(processingPath);
        fail("Payment intent has expired", "INTENT_EXPIRED");
      }
      return {
        value,
        consume() {
          try {
            unlinkSync(processingPath);
          } catch {}
        },
        restore() {
          renameSync(processingPath, path);
        },
      };
    },
  };
}

function safeTokenSymbol(value) {
  return typeof value === "string" && /^[A-Za-z0-9 ._-]{1,32}$/.test(value)
    ? value
    : null;
}

function normalizeDecimal(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return text;
  if (!text.includes(".")) return text;
  const normalized = text.replace(/0+$/, "").replace(/\.$/, "");
  return normalized === "" ? "0" : normalized;
}

function roundDecimal(value, places) {
  const normalized = normalizeDecimal(value);
  if (normalized == null || !/^\d+(?:\.\d+)?$/.test(normalized)) return null;

  const [whole, fraction = ""] = normalized.split(".");
  const kept = fraction.padEnd(places, "0").slice(0, places);
  let scaled = BigInt(`${whole}${kept}` || "0");
  if ((fraction[places] || "0") >= "5") scaled += 1n;

  const digits = scaled.toString().padStart(places + 1, "0");
  if (places === 0) return digits;
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function formatUsdLabel(value) {
  const normalized = normalizeDecimal(value);
  if (normalized == null || !/^\d+(?:\.\d+)?$/.test(normalized)) return null;

  const [whole, fraction = ""] = normalized.split(".");
  const atLeastOneCent =
    BigInt(whole) > 0n || BigInt(fraction.padEnd(2, "0").slice(0, 2)) >= 1n;
  return `$${roundDecimal(normalized, atLeastOneCent ? 2 : 6)}`;
}

function tokenMetadata(option) {
  const declaredSymbol = safeTokenSymbol(option.extra?.name);
  const canonicalSymbol =
    declaredSymbol === "USD Coin" ? "USDC" : declaredSymbol;
  const known = TOKEN_METADATA.get(`${option.network}:${canonicalSymbol}`);
  const declaredDecimals = Number(option.extra?.decimals);
  const decimals =
    known?.decimals ??
    (Number.isInteger(declaredDecimals) &&
    declaredDecimals >= 0 &&
    declaredDecimals <= 36
      ? declaredDecimals
      : null);
  return {
    symbol: known?.symbol ?? canonicalSymbol,
    decimals,
  };
}

function formatUnits(value, decimals) {
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(decimals)) return null;
  const padded = String(value).padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function publicServerOptions(requirements) {
  return enumeratePaymentOptions(requirements).map((option, index) => ({
    originalIndex: index,
    displayIndex: index + 1,
    scheme: option.scheme,
    network: option.network,
    networkName: NETWORK_METADATA[option.network]?.name ?? option.network,
    networkEnvironment:
      NETWORK_METADATA[option.network]?.environment ?? "unknown",
    asset: option.asset,
    ...(() => {
      const metadata = tokenMetadata(option);
      const displayAmount = formatUnits(option.amount, metadata.decimals);
      return {
        tokenSymbol: metadata.symbol,
        displayAmount,
        amountLabel: displayAmount
          ? `${displayAmount}${metadata.symbol ? ` ${metadata.symbol}` : ""}`
          : `${option.amount} base units${metadata.symbol ? ` ${metadata.symbol}` : ""}`,
      };
    })(),
    payTo: option.payTo,
    assetTransferMethod: option.extra?.assetTransferMethod ?? null,
  }));
}

function publicWalletSetup(reason, walletStatus = null) {
  return {
    walletStatus,
    options: WALLET_SETUP_OPTIONS.map((option) => ({
      ...option,
      installed:
        option.id === "binance-agentic-wallet"
          ? reason !== "WALLET_UNAVAILABLE"
          : null,
      connected:
        option.id === "binance-agentic-wallet"
          ? walletStatus === "CONNECTED"
          : null,
    })),
    actions: ["connect_or_install", "configure_x402_buyer", "connect_other_wallet", "stop"],
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function walletRequiredPresentation({ request, reason, walletStatus, serverOptions }) {
  const chinese = /[\u3400-\u9fff]/u.test(request.message);
  const rows = serverOptions
    .map((option) => {
      const environment =
        option.networkEnvironment === "mainnet"
          ? chinese
            ? "主网"
            : "mainnet"
          : option.networkEnvironment === "testnet"
            ? chinese
              ? "测试网"
              : "testnet"
            : chinese
              ? "环境未知"
              : "environment unknown";
      const asset = option.tokenSymbol
        ? `${option.tokenSymbol} — \`${markdownCell(option.asset)}\``
        : `\`${markdownCell(option.asset)}\``;
      return `| ${option.originalIndex} | ${markdownCell(option.networkName)}（\`${markdownCell(option.network)}\`，${environment}） | ${asset} | ${markdownCell(option.amountLabel)} | \`${markdownCell(option.payTo)}\` |`;
    })
    .join("\n");
  const hasMainnet = serverOptions.some(
    (option) => option.networkEnvironment === "mainnet"
  );
  const binanceStatus =
    reason === "WALLET_UNAVAILABLE"
      ? chinese
        ? "尚未安装"
        : "not installed"
      : walletStatus === "UNCONNECTED"
        ? chinese
          ? "已安装，目前未登录"
          : "installed, currently signed out"
        : chinese
          ? "当前不可用"
          : "currently unavailable";

  if (chinese) {
    return `Cournot 免费额度已耗尽，本次未获得概率结果，也未发生任何付款。

可用付款路线：

| 原始索引 | 网络 | 资产 | 金额 | 收款地址 |
|---|---|---|---|---|
${rows}
${hasMainnet ? "\n主网付款会转移真实资产。" : ""}

可选设置方式：

- 推荐：[Binance Agentic Wallet](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet)（${binanceStatus}）
- [x402 Foundation Buyer Quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [viem Local Accounts](https://viem.sh/docs/accounts/local)

可选操作：

1. 连接或安装 Binance Agentic Wallet
2. 配置 x402 Buyer Quickstart 和 viem Local Accounts
3. 连接其他兼容钱包
4. 停止，不付款

执行任何钱包设置前，我会展示具体操作和风险并再次确认；钱包设置确认不等于付款确认。

${walletStatus === "UNCONNECTED" ? "如果你已有 Binance Agentic Wallet，请回复“登录钱包”；如果尚未创建，需要先在 Binance App 中创建。" : "请选择一种设置方式，或选择停止。"}`;
  }

  return `Cournot free quota is exhausted. No probability was obtained and no payment occurred.

Available payment routes:

| Original index | Network | Asset | Amount | Recipient |
|---|---|---|---|---|
${rows}
${hasMainnet ? "\nMainnet payment transfers real assets." : ""}

Setup options:

- Recommended: [Binance Agentic Wallet](https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet) (${binanceStatus})
- [x402 Foundation Buyer Quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [viem Local Accounts](https://viem.sh/docs/accounts/local)

Available actions:

1. Connect or install Binance Agentic Wallet
2. Configure x402 Buyer Quickstart with viem Local Accounts
3. Connect another compatible wallet
4. Stop without paying

Before any wallet setup, I will show the exact action and risks and ask for separate confirmation. Wallet setup confirmation is not payment confirmation.

${walletStatus === "UNCONNECTED" ? 'Reply "sign in to wallet" if you already have a Binance Agentic Wallet. If you have not created one, create it in the Binance App first.' : "Choose one setup option, or stop."}`;
}

function walletRequiredResult({ request, reason, walletStatus = null, serverOptions }) {
  return {
    state: "wallet_required",
    reason,
    ...(walletStatus ? { walletStatus } : {}),
    serverOptions,
    walletSetup: publicWalletSetup(reason, walletStatus),
    presentation: walletRequiredPresentation({
      request,
      reason,
      walletStatus,
      serverOptions,
    }),
  };
}

function matchingAcceptIndex(requirements, originalAccept) {
  if (!isObject(originalAccept)) return null;
  const accepts = parsePaymentRequirements(requirements).accepts;
  const index = accepts.findIndex((accept) =>
    ["scheme", "network", "asset", "amount", "payTo"].every((field) =>
      sameValue(accept[field], originalAccept[field])
    )
  );
  return index === -1 ? null : index;
}

function sanitizePreviewOptions(previewOptions, requirements) {
  const ready = [];
  const blockers = [];
  for (const option of previewOptions) {
    const originalAcceptIndex = matchingAcceptIndex(
      requirements,
      option.originalAccept
    );
    const safe = {
      walletOptionIndex: option.index,
      status: option.status,
      reasons: Array.isArray(option.reasons) ? option.reasons : [],
      network: option.originalAccept?.network ?? null,
      tokenAddress: option.tokenAddress ?? option.originalAccept?.asset ?? null,
      tokenSymbol: option.tokenSymbol ?? null,
      amount: option.amount ?? null,
      amountUsd: option.amountUsd ?? null,
      payTo: option.payTo ?? option.originalAccept?.payTo ?? null,
      currentBalance: option.currentBalance ?? null,
      currentBalanceUsd: option.currentBalanceUsd ?? null,
      needApproveFirst: option.needApproveFirst === true,
      originalAcceptIndex,
    };
    if (option.status === "READY_TO_SIGN" && originalAcceptIndex !== null) {
      ready.push(safe);
    } else {
      blockers.push(safe);
    }
  }
  return { ready, blockers };
}

function publicReadyOptions(ready) {
  return ready.map((option, index) => {
    const amount = normalizeDecimal(option.amount);
    const currentBalance = normalizeDecimal(option.currentBalance);
    const amountUsd = normalizeDecimal(option.amountUsd);
    const currentBalanceUsd = normalizeDecimal(option.currentBalanceUsd);
    return {
      displayIndex: index + 1,
      network: option.network,
      tokenAddress: option.tokenAddress,
      tokenSymbol: option.tokenSymbol,
      amount,
      amountLabel:
        amount == null
          ? null
          : `${amount}${option.tokenSymbol ? ` ${option.tokenSymbol}` : ""}`,
      amountUsd,
      amountUsdLabel: formatUsdLabel(amountUsd),
      payTo: option.payTo,
      currentBalance,
      balanceLabel:
        currentBalance == null
          ? null
          : `${currentBalance}${option.tokenSymbol ? ` ${option.tokenSymbol}` : ""}`,
      currentBalanceUsd,
      balanceUsdLabel: formatUsdLabel(currentBalanceUsd),
      needApproveFirst: option.needApproveFirst,
    };
  });
}

function publicBlockers(blockers) {
  return blockers.map((option) => ({
    status: option.status,
    reasons: option.reasons,
    network: option.network,
    tokenAddress: option.tokenAddress,
  }));
}

export async function prepareProbability({
  request,
  fetchImpl = fetch,
  wallet = createBinanceWalletRunner(),
  intents = createFileIntentStore(),
} = {}) {
  const originalRequest = validateProbabilityRequest(request);
  const initial = await postProbability(fetchImpl, originalRequest);
  if (initial.status !== 402) {
    return redactSensitive({
      state: "complete",
      httpStatus: initial.status,
      response: normalizeResponseForDisplay(initial.body),
    });
  }
  if (!initial.paymentRequired) {
    fail("Cournot 402 response is missing PAYMENT-REQUIRED", "INVALID_402");
  }

  const requirements = parsePaymentRequirements(initial.paymentRequired);
  const serverOptions = publicServerOptions(requirements);
  if (typeof wallet.preflight === "function") {
    let preflight;
    try {
      preflight = wallet.preflight();
    } catch (error) {
      return walletRequiredResult({
        request: originalRequest,
        reason: error.code || "WALLET_UNAVAILABLE",
        serverOptions,
      });
    }
    if (preflight?.connected !== true) {
      return walletRequiredResult({
        request: originalRequest,
        reason: "WALLET_NOT_CONNECTED",
        walletStatus: preflight?.status ?? "UNKNOWN",
        serverOptions,
      });
    }
  }
  let preview;
  try {
    preview = wallet.preview(initial.paymentRequired);
  } catch (error) {
    return walletRequiredResult({
      request: originalRequest,
      reason: error.code || "WALLET_UNAVAILABLE",
      serverOptions,
    });
  }
  if (
    preview?.success !== true ||
    typeof preview?.data?.paymentId !== "string" ||
    !Array.isArray(preview?.data?.options)
  ) {
    fail("Binance Agentic Wallet preview failed", "WALLET_PREVIEW_FAILED");
  }

  const { ready, blockers } = sanitizePreviewOptions(
    preview.data.options,
    requirements
  );
  if (ready.length === 0) {
    return {
      state: "wallet_blocked",
      serverOptions,
      blockers: publicBlockers(blockers),
    };
  }

  const intentId = intents.save({
    request: originalRequest,
    requirements,
    walletPaymentId: preview.data.paymentId,
    ready,
  });
  return {
    state: "payment_confirmation_required",
    intentId,
    serverOptions,
    options: publicReadyOptions(ready),
    blockers: publicBlockers(blockers),
  };
}

function parseSignedPayment(result) {
  if (
    result?.success !== true ||
    result?.data?.paymentHeaderName !== "PAYMENT-SIGNATURE" ||
    typeof result?.data?.paymentHeaderValue !== "string" ||
    result.data.paymentHeaderValue === ""
  ) {
    fail("Binance Agentic Wallet signing failed", "WALLET_SIGN_FAILED");
  }
  return result.data;
}

export async function executePayment({
  intentId,
  selectedOption,
  confirmed,
  fetchImpl = fetch,
  wallet = createBinanceWalletRunner(),
  intents = createFileIntentStore(),
} = {}) {
  if (confirmed !== true) {
    fail("Explicit user confirmation is required", "CONFIRMATION_REQUIRED");
  }
  if (!Number.isInteger(selectedOption) || selectedOption < 1) {
    fail("A valid displayed payment option is required");
  }

  const lease = intents.take(intentId);
  const intent = lease.value;
  const selected = intent.ready[selectedOption - 1];
  if (!selected) {
    lease.restore();
    fail("Selected payment option does not exist");
  }

  let signed;
  try {
    signed = parseSignedPayment(
      wallet.sign(intent.walletPaymentId, selected.walletOptionIndex)
    );
  } catch (error) {
    lease.consume();
    throw error;
  }

  try {
    if (signed.approveTxHash) {
      const confirmedApproval = await wallet.waitForApproval(
        signed.approveTxHash,
        signed.binanceChainId
      );
      if (!confirmedApproval) {
        return {
          state: "approval_pending",
          approveTxHash: signed.approveTxHash,
          binanceChainId: signed.binanceChainId ?? null,
          next: "Prepare a fresh payment after the approval confirms.",
        };
      }
    }

    let paymentHeader;
    try {
      paymentHeader = buildPaymentHeader(
        signed.paymentHeaderValue,
        intent.requirements,
        selected.originalAcceptIndex + 1
      );
    } catch (error) {
      fail("Wallet payment did not match the confirmed option", "PAYMENT_MISMATCH");
    }

    const paid = await postProbability(fetchImpl, intent.request, paymentHeader);
    const settled =
      paid.status >= 200 && paid.status < 300 && paid.body?.code === 0;
    return redactSensitive({
      state: settled ? "complete" : "payment_failed",
      httpStatus: paid.status,
      response: normalizeResponseForDisplay(paid.body),
    });
  } finally {
    lease.consume();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value == null) {
      fail("Arguments must use --name value pairs");
    }
    args[key.slice(2)] = value;
  }
  return { command, args };
}

function decodeRequest(value) {
  if (typeof value !== "string" || value === "") {
    fail("--request-base64 is required");
  }
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    fail("--request-base64 must contain base64 JSON");
  }
}

async function runCli() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "prepare") {
    return prepareProbability({ request: decodeRequest(args["request-base64"]) });
  }
  if (command === "execute") {
    return executePayment({
      intentId: args.intent,
      selectedOption: Number(args["selected-option"]),
      confirmed: args.confirmed === "true",
    });
  }
  fail(
    "Usage: cournot-client.mjs prepare --request-base64 <base64-json> | execute --intent <id> --selected-option <n> --confirmed true"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    console.log(JSON.stringify(await runCli()));
  } catch (error) {
    console.error(
      JSON.stringify({
        success: false,
        code: error.code || "COURNOT_CLIENT_ERROR",
        message: error.message,
      })
    );
    process.exitCode = 1;
  }
}
