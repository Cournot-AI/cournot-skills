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
  resource: { url: "https://dev-interface.cournot.ai/intelligence/v1/probability" },
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

const encodedRequirements = Buffer.from(JSON.stringify(requirements)).toString(
  "base64"
);

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function paymentRequiredResponse() {
  return new Response(null, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodedRequirements },
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
          amount: "0.01",
          amountUsd: "0.01",
          payTo: requirements.accepts[1].payTo,
          currentBalance: "1.00",
          currentBalanceUsd: "1.00",
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

test("free probability response completes without touching the wallet", async () => {
  let walletCalls = 0;
  const result = await prepareProbability({
    request,
    fetchImpl: async () =>
      jsonResponse({ code: 0, data: { result: { point_estimate: 0.61 } } }),
    wallet: wallet({
      preview() {
        walletCalls += 1;
      },
    }),
    intents: createMemoryIntentStore(),
  });

  assert.equal(result.state, "complete");
  assert.equal(result.response.data.result.point_estimate, 0.61);
  assert.equal(walletCalls, 0);
});

test("402 preparation exposes every route but no wallet credential", async () => {
  const { prepared } = await preparedPayment();
  const serialized = JSON.stringify(prepared);

  assert.equal(prepared.state, "payment_confirmation_required");
  assert.equal(prepared.serverOptions.length, 2);
  assert.equal(prepared.options.length, 1);
  assert.equal(prepared.options[0].displayIndex, 1);
  assert.equal(prepared.options[0].network, "eip155:56");
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
  assert.equal(previewCalls, 0);
  assert.equal("intentId" in prepared, false);
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
