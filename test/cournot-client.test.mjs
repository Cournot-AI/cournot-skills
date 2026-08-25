import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileIntentStore,
  executePayment,
  prepareProbability,
} from "../skills/cournot/scripts/cournot-client.mjs";

const request = {
  message: "Will BTC set a new all-time high this year?",
  market_ids: [42],
};

const requirements = {
  x402Version: 2,
  resource: { url: "https://interface.cournot.ai/intelligence/v1/probability" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x1111111111111111111111111111111111111111",
      amount: "10000",
      payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    },
    {
      scheme: "exact",
      network: "eip155:56",
      asset: "0x2222222222222222222222222222222222222222",
      amount: "10000000000000000",
      payTo: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      extra: { name: "USD1", version: "1", assetTransferMethod: "eip3009" },
    },
  ],
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function paymentRequiredResponse(value = requirements) {
  return new Response(null, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(value)).toString("base64"),
    },
  });
}

function createMemoryIntentStore() {
  const values = new Map();
  let sequence = 0;
  return {
    save(value) {
      sequence += 1;
      const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      values.set(id, structuredClone(value));
      return id;
    },
    take(id) {
      if (!values.has(id)) {
        const error = new Error("Payment intent is missing or already used");
        error.code = "INTENT_UNAVAILABLE";
        throw error;
      }
      const value = values.get(id);
      values.delete(id);
      return {
        value: structuredClone(value),
        consume() {},
        restore() {
          values.set(id, value);
        },
      };
    },
  };
}

function previewResult({ ready = true } = {}) {
  return {
    success: true,
    data: {
      paymentId: "wallet-payment-id-must-stay-internal",
      options: [
        {
          index: 1,
          status: "NOT_SIGNABLE",
          reasons: ["UNSUPPORTED_NETWORK"],
          originalAccept: requirements.accepts[0],
        },
        {
          index: 2,
          status: ready ? "READY_TO_SIGN" : "ACTION_REQUIRED",
          reasons: ready ? [] : ["INSUFFICIENT_BALANCE"],
          tokenAddress: requirements.accepts[1].asset,
          tokenSymbol: "USD1",
          amount: "0.010000000000000000",
          amountUsd: "0.00999693449049656950064711307462542454",
          payTo: requirements.accepts[1].payTo,
          currentBalance: "4.980000000000000000",
          currentBalanceUsd: "4.96847644177679504182161519808883599638",
          needApproveFirst: false,
          originalAccept: requirements.accepts[1],
        },
      ],
    },
  };
}

function signedResult(overrides = {}) {
  const accept = requirements.accepts[1];
  const envelope = {
    x402Version: requirements.x402Version,
    accepted: accept,
    payload: {
      signature: "wallet-signature-must-stay-internal",
      authorization: {
        from: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        to: accept.payTo,
        value: accept.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "wallet-nonce-must-stay-internal",
      },
    },
  };
  return {
    success: true,
    data: {
      paymentHeaderName: "PAYMENT-SIGNATURE",
      paymentHeaderValue: Buffer.from(JSON.stringify(envelope)).toString("base64"),
      approveTxHash: null,
      binanceChainId: null,
      ...overrides,
    },
  };
}

function wallet(overrides = {}) {
  return {
    preview: () => previewResult(),
    sign: () => signedResult(),
    waitForApproval: async () => true,
    ...overrides,
  };
}

async function preparedPayment({ walletImpl = wallet(), intents } = {}) {
  const store = intents || createMemoryIntentStore();
  const prepared = await prepareProbability({
    request,
    fetchImpl: async () => paymentRequiredResponse(),
    wallet: walletImpl,
    intents: store,
  });
  return { prepared, intents: store };
}

test("default probability request targets the production API", async () => {
  let requestedUrl;
  const result = await prepareProbability({
    request,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({ code: 0, data: { probability: 0.5 } });
    },
    wallet: wallet(),
  });

  assert.equal(
    requestedUrl,
    "https://interface.cournot.ai/intelligence/v1/probability"
  );
  assert.equal(result.state, "complete");
});

test("free probability response completes without touching the wallet", async () => {
  let walletCalls = 0;
  const result = await prepareProbability({
    request,
    fetchImpl: async () =>
      jsonResponse({
        code: 0,
        data: {
          result: { point_estimate: 0.61 },
          basis: [
            {
              source: "mock",
              summary:
                'Market "Bitcoin above $150,000 before 2027-01-01T05:00:00Z" observed at 2000-01-01T21:00:00+01:00.',
              time: "2000-01-01T20:00:00Z",
              url: "https://example.com/market?id=1",
            },
            {
              source: "offset",
              time: "2000-01-01T21:00:00+01:00",
              url: "https://example.com/source",
            },
          ],
          probability: {
            basis: {
              cross_checks: [
                {
                  source: "nested",
                  time: "2000-01-01T20:00:00.999Z",
                  url: "javascript:alert(1)",
                },
              ],
            },
          },
          free_quota: {
            ip: "192.0.2.1",
            total: 3,
            used: 1,
            remaining: 2,
          },
        },
      }),
    wallet: wallet({
      preview() {
        walletCalls += 1;
      },
    }),
    intents: createMemoryIntentStore(),
  });

  assert.equal(result.state, "complete");
  assert.equal(result.response.data.result.point_estimate, 0.61);
  assert.deepEqual(
    result.response.data.basis.map(({ time }) => time),
    ["2000-01-01 20:00:00 UTC", "2000-01-01 20:00:00 UTC"]
  );
  assert.equal(
    result.response.data.basis[0].summary,
    'Market "[Bitcoin above $150,000 before 2027-01-01 05:00:00 UTC](<https://example.com/market?id=1>)" observed at 2000-01-01 20:00:00 UTC.'
  );
  assert.equal(
    result.response.data.basis[1].source,
    "[offset](<https://example.com/source>)"
  );
  assert.doesNotMatch(JSON.stringify(result.response.data.basis), /T20:|Z"/);
  assert.equal(
    result.response.data.probability.basis.cross_checks[0].time,
    "2000-01-01 20:00:00 UTC"
  );
  assert.equal(
    result.response.data.probability.basis.cross_checks[0].source,
    "nested"
  );
  assert.doesNotMatch(JSON.stringify(result.response.data), /"url":/);
  assert.deepEqual(result.response.data.free_quota, {
    total: 3,
    used: 1,
    remaining: 2,
  });
  assert.equal(walletCalls, 0);
});

test("402 preparation exposes every route but no wallet credential", async () => {
  const { prepared } = await preparedPayment();
  const serialized = JSON.stringify(prepared);

  assert.equal(prepared.state, "payment_confirmation_required");
  assert.equal(prepared.serverOptions.length, 2);
  assert.deepEqual(
    prepared.serverOptions.map((option) => ({
      originalIndex: option.originalIndex,
      network: option.network,
      tokenSymbol: option.tokenSymbol,
      displayAmount: option.displayAmount,
      amountLabel: option.amountLabel,
    })),
    [
      {
        originalIndex: 0,
        network: "eip155:8453",
        tokenSymbol: "USDC",
        displayAmount: "0.01",
        amountLabel: "0.01 USDC",
      },
      {
        originalIndex: 1,
        network: "eip155:56",
        tokenSymbol: "USD1",
        displayAmount: "0.01",
        amountLabel: "0.01 USD1",
      },
    ]
  );
  assert.equal(prepared.options.length, 1);
  assert.equal(prepared.options[0].displayIndex, 1);
  assert.equal(prepared.options[0].network, "eip155:56");
  assert.equal(prepared.options[0].amount, "0.01");
  assert.equal(prepared.options[0].amountLabel, "0.01 USD1");
  assert.equal(prepared.options[0].currentBalance, "4.98");
  assert.equal(prepared.options[0].balanceLabel, "4.98 USD1");
  assert.equal(
    prepared.options[0].amountUsd,
    "0.00999693449049656950064711307462542454"
  );
  assert.equal(prepared.options[0].amountUsdLabel, "$0.009997");
  assert.equal(
    prepared.options[0].currentBalanceUsd,
    "4.96847644177679504182161519808883599638"
  );
  assert.equal(prepared.options[0].balanceUsdLabel, "$4.97");
  assert.doesNotMatch(serialized, /0\.010000000000000000/);
  assert.doesNotMatch(serialized, /wallet-payment-id-must-stay-internal/);
  assert.doesNotMatch(serialized, /paymentHeaderValue|signature|nonce/i);
});

test("wallet absence returns sanitized merchant routes without an intent", async () => {
  const unavailable = new Error("not installed");
  unavailable.code = "WALLET_UNAVAILABLE";
  const { prepared } = await preparedPayment({
    walletImpl: wallet({
      preview() {
        throw unavailable;
      },
    }),
  });

  assert.equal(prepared.state, "wallet_required");
  assert.equal(prepared.reason, "WALLET_UNAVAILABLE");
  assert.equal(prepared.serverOptions.length, 2);
  assert.deepEqual(
    prepared.walletSetup.options.map(({ name, recommended }) => ({
      name,
      recommended,
    })),
    [
      { name: "Binance Agentic Wallet", recommended: true },
      { name: "x402 Foundation Buyer Quickstart", recommended: false },
      { name: "viem Local Accounts", recommended: false },
    ]
  );
  assert.equal(prepared.walletSetup.options[0].installed, false);
  assert.equal("intentId" in prepared, false);
});

test("a disconnected wallet stops before preview or intent creation", async () => {
  let previewCalls = 0;
  const { prepared } = await preparedPayment({
    walletImpl: wallet({
      preflight: () => ({ connected: false, status: "UNCONNECTED" }),
      preview() {
        previewCalls += 1;
      },
    }),
  });

  assert.equal(prepared.state, "wallet_required");
  assert.equal(prepared.reason, "WALLET_NOT_CONNECTED");
  assert.equal(prepared.walletStatus, "UNCONNECTED");
  assert.equal(prepared.walletSetup.options[0].installed, true);
  assert.equal(prepared.walletSetup.options[0].connected, false);
  assert.match(prepared.presentation, /0\.01 USDC/);
  assert.match(prepared.presentation, /0\.01 USD1/);
  assert.match(prepared.presentation, /x402 Foundation Buyer Quickstart/);
  assert.match(prepared.presentation, /viem Local Accounts/);
  assert.doesNotMatch(prepared.presentation, /10000000000000000|raw amount|原始金额/);
  assert.equal(previewCalls, 0);
  assert.equal("intentId" in prepared, false);
});

test("Chinese no-wallet presentation is deterministic and human-readable", async () => {
  const paymentRequirements = {
    x402Version: 2,
    resource: { url: "" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x1111111111111111111111111111111111111111",
        amount: "10000",
        payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
      },
      {
        scheme: "exact",
        network: "eip155:56",
        asset: "0x2222222222222222222222222222222222222222",
        amount: "10000000000000000",
        payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        extra: { name: "USD1", version: "1", assetTransferMethod: "eip3009" },
      },
    ],
  };
  const result = await prepareProbability({
    request: { message: "BTC 年底前会到 15 万美元吗", market_ids: [101] },
    fetchImpl: async () => paymentRequiredResponse(paymentRequirements),
    wallet: wallet({
      preflight: () => ({ connected: false, status: "UNCONNECTED" }),
    }),
    intents: createMemoryIntentStore(),
  });

  assert.equal(result.state, "wallet_required");
  assert.match(result.presentation, /\| 0 \| Base Sepolia/);
  assert.match(result.presentation, /0\.01 USDC/);
  assert.match(result.presentation, /0\.01 USD1/);
  assert.match(result.presentation, /Binance Agentic Wallet/);
  assert.match(result.presentation, /x402 Foundation Buyer Quickstart/);
  assert.match(result.presentation, /viem Local Accounts/);
  assert.match(result.presentation, /请回复“登录钱包”/);
  assert.doesNotMatch(
    result.presentation,
    /原始金额|10000000000000000|wallet-signature|nonce/i
  );
});

test("wallet blockers are returned without creating a signable intent", async () => {
  const { prepared } = await preparedPayment({
    walletImpl: wallet({ preview: () => previewResult({ ready: false }) }),
  });

  assert.equal(prepared.state, "wallet_blocked");
  assert.deepEqual(
    prepared.blockers.flatMap(({ reasons }) => reasons),
    ["UNSUPPORTED_NETWORK", "INSUFFICIENT_BALANCE"]
  );
  assert.equal("intentId" in prepared, false);
});

test("execution cannot sign before explicit confirmation", async () => {
  let signCalls = 0;
  const { prepared, intents } = await preparedPayment();

  await assert.rejects(
    executePayment({
      intentId: prepared.intentId,
      selectedOption: 1,
      confirmed: false,
      wallet: wallet({
        sign() {
          signCalls += 1;
        },
      }),
      intents,
    }),
    /confirmation/i
  );
  assert.equal(signCalls, 0);
});

test("confirmed execution signs the mapped option and replays the exact request", async () => {
  const { prepared, intents } = await preparedPayment();
  let signedIndex;
  let replayCount = 0;
  const result = await executePayment({
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet({
      sign(paymentId, selectedIndex) {
        assert.equal(paymentId, "wallet-payment-id-must-stay-internal");
        signedIndex = selectedIndex;
        return signedResult();
      },
    }),
    intents,
    fetchImpl: async (_url, init) => {
      replayCount += 1;
      assert.deepEqual(JSON.parse(init.body), request);
      const payment = JSON.parse(
        Buffer.from(init.headers["PAYMENT-SIGNATURE"], "base64").toString("utf8")
      );
      assert.equal(payment.scheme, requirements.accepts[1].scheme);
      assert.equal(payment.network, requirements.accepts[1].network);
      assert.equal(payment.payload.authorization.to, requirements.accepts[1].payTo);
      return jsonResponse({
        code: 0,
        data: {
          result: { point_estimate: 0.64 },
          signature: "merchant-must-not-leak-this",
          nonce: "merchant-nonce-must-not-leak-this",
        },
      });
    },
  });

  assert.equal(signedIndex, 2);
  assert.equal(replayCount, 1);
  assert.equal(result.state, "complete");
  assert.equal(result.response.data.result.point_estimate, 0.64);
  assert.equal(result.response.data.signature, "[REDACTED]");
  assert.equal(result.response.data.nonce, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /wallet-signature|wallet-nonce/);
});

test("a consumed intent cannot sign or pay twice", async () => {
  const { prepared, intents } = await preparedPayment();
  const options = {
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet(),
    intents,
    fetchImpl: async () => jsonResponse({ code: 0, data: {} }),
  };

  await executePayment(options);
  await assert.rejects(executePayment(options), /already used/);
});

test("an invalid displayed choice does not consume a valid intent", async () => {
  const { prepared, intents } = await preparedPayment();
  await assert.rejects(
    executePayment({
      intentId: prepared.intentId,
      selectedOption: 2,
      confirmed: true,
      wallet: wallet(),
      intents,
    }),
    /does not exist/
  );

  const result = await executePayment({
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet(),
    intents,
    fetchImpl: async () => jsonResponse({ code: 0, data: {} }),
  });
  assert.equal(result.state, "complete");
});

test("file intents are permission-restricted and expire closed", () => {
  const parent = mkdtempSync(join(tmpdir(), "cournot-intent-test-"));
  const directory = join(parent, "intents");
  let time = 1_000;
  const intentId = "00000000-0000-4000-8000-000000000001";
  try {
    const intents = createFileIntentStore({
      directory,
      now: () => time,
      createId: () => intentId,
    });
    intents.save({ request });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, `${intentId}.json`)).mode & 0o777, 0o600);

    time += 30 * 60 * 1000 + 1;
    assert.throws(() => intents.take(intentId), /expired/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a 2xx settlement error is payment_failed and consumes the intent", async () => {
  const { prepared, intents } = await preparedPayment();
  const options = {
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet(),
    intents,
    fetchImpl: async () =>
      jsonResponse({ code: 22000, msg: "settlement failed" }),
  };

  const result = await executePayment(options);
  assert.equal(result.state, "payment_failed");
  assert.equal(result.response.code, 22000);
  await assert.rejects(executePayment(options), /already used/);
});

test("a wallet envelope for another route is rejected and never replayed", async () => {
  const { prepared, intents } = await preparedPayment();
  const wrongAccept = requirements.accepts[0];
  const mismatched = signedResult();
  const decoded = JSON.parse(
    Buffer.from(mismatched.data.paymentHeaderValue, "base64").toString("utf8")
  );
  decoded.accepted = wrongAccept;
  mismatched.data.paymentHeaderValue = Buffer.from(JSON.stringify(decoded)).toString(
    "base64"
  );
  let replayed = false;

  await assert.rejects(
    executePayment({
      intentId: prepared.intentId,
      selectedOption: 1,
      confirmed: true,
      wallet: wallet({ sign: () => mismatched }),
      intents,
      fetchImpl: async () => {
        replayed = true;
        return jsonResponse({ code: 0 });
      },
    }),
    /did not match/
  );
  assert.equal(replayed, false);
});

test("a replay network failure still consumes the signed intent", async () => {
  const { prepared, intents } = await preparedPayment();
  const options = {
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet(),
    intents,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  };

  await assert.rejects(executePayment(options), /network unavailable/);
  await assert.rejects(executePayment(options), /already used/);
});

test("Permit2 approval timeout discards the one-time authorization", async () => {
  const { prepared, intents } = await preparedPayment();
  let replayed = false;
  const result = await executePayment({
    intentId: prepared.intentId,
    selectedOption: 1,
    confirmed: true,
    wallet: wallet({
      sign: () =>
        signedResult({
          approveTxHash: "0xapproval",
          binanceChainId: "56",
        }),
      waitForApproval: async () => false,
    }),
    intents,
    fetchImpl: async () => {
      replayed = true;
      return jsonResponse({ code: 0 });
    },
  });

  assert.equal(result.state, "approval_pending");
  assert.equal(result.approveTxHash, "0xapproval");
  assert.equal(replayed, false);
  await assert.rejects(
    executePayment({
      intentId: prepared.intentId,
      selectedOption: 1,
      confirmed: true,
      wallet: wallet(),
      intents,
    }),
    /already used/
  );
});
