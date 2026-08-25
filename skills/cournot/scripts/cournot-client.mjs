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

const PRODUCTION_API_BASE = "https://dev-interface.cournot.ai";
const INTENT_TTL_MS = 30 * 60 * 1000;
const APPROVAL_WAIT_MS = 45 * 1000;
const APPROVAL_POLL_MS = 3 * 1000;

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

function publicServerOptions(requirements) {
  return enumeratePaymentOptions(requirements).map((option, index) => ({
    displayIndex: index + 1,
    scheme: option.scheme,
    network: option.network,
    asset: option.asset,
    amount: option.amount,
    payTo: option.payTo,
    assetTransferMethod: option.extra?.assetTransferMethod ?? null,
  }));
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
  return ready.map((option, index) => ({
    displayIndex: index + 1,
    network: option.network,
    tokenAddress: option.tokenAddress,
    tokenSymbol: option.tokenSymbol,
    amount: option.amount,
    amountUsd: option.amountUsd,
    payTo: option.payTo,
    currentBalance: option.currentBalance,
    currentBalanceUsd: option.currentBalanceUsd,
    needApproveFirst: option.needApproveFirst,
  }));
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
      response: initial.body,
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
      return {
        state: "wallet_required",
        reason: error.code || "WALLET_UNAVAILABLE",
        serverOptions,
      };
    }
    if (preflight?.connected !== true) {
      return {
        state: "wallet_required",
        reason: "WALLET_NOT_CONNECTED",
        walletStatus: preflight?.status ?? "UNKNOWN",
        serverOptions,
      };
    }
  }
  let preview;
  try {
    preview = wallet.preview(initial.paymentRequired);
  } catch (error) {
    return {
      state: "wallet_required",
      reason: error.code || "WALLET_UNAVAILABLE",
      serverOptions,
    };
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
      response: paid.body,
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
