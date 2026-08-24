import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSameProbabilityRequest,
  assertUnusedNonce,
  buildPaymentHeader,
  enumeratePaymentOptions,
  normalizePaymentEnvelope,
  parsePaymentRequirements,
  planPayment,
  selectPaymentOption,
  walletSupportsOption,
} from "../skills/cournot/scripts/payment-flow.mjs";

const requirements = {
  x402Version: 2,
  resource: { url: "" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x1111111111111111111111111111111111111111",
      amount: "10000",
      payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    },
    {
      scheme: "exact",
      network: "eip155:56",
      asset: "0x2222222222222222222222222222222222222222",
      amount: "10000000000000000",
      payTo: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      maxTimeoutSeconds: 300,
      extra: { name: "USD1", version: "1", assetTransferMethod: "eip3009" },
    },
    {
      scheme: "exact",
      network: "eip155:999",
      asset: "0x3333333333333333333333333333333333333333",
      amount: "7",
      payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      maxTimeoutSeconds: 120,
      extra: { name: "Future Token", version: "9", assetTransferMethod: "eip3009" },
    },
  ],
};

const encodedRequirements = Buffer.from(JSON.stringify(requirements)).toString(
  "base64"
);

const wallets = {
  base: {
    id: "base-wallet",
    name: "Base Wallet",
    networks: ["eip155:8453"],
    schemes: ["exact"],
  },
  bsc: {
    id: "binance-wallet",
    name: "Binance Agentic Wallet",
    networks: ["eip155:56"],
    schemes: ["exact"],
  },
  future: {
    id: "future-wallet",
    name: "Future Wallet",
    networks: ["eip155:999"],
    assets: ["0x3333333333333333333333333333333333333333"],
  },
};

function envelopeFor(index, overrides = {}) {
  const accept = requirements.accepts[index - 1];
  const authorization = {
    from: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    to: accept.payTo.toLowerCase(),
    value: accept.amount,
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `nonce-${index}`,
    ...overrides.authorization,
  };
  return {
    x402Version: 2,
    accepted: { ...accept, ...overrides.accepted },
    payload: {
      signature: `signature-${index}`,
      authorization,
      ...overrides.payload,
    },
    ...overrides.envelope,
  };
}

function mockSettle(header, selectedIndex) {
  const payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const accept = requirements.accepts[selectedIndex - 1];
  assert.equal(payment.x402Version, requirements.x402Version);
  assert.equal(payment.scheme, accept.scheme);
  assert.equal(payment.network, accept.network);
  assert.equal(payment.payload.authorization.to.toLowerCase(), accept.payTo.toLowerCase());
  assert.equal(payment.payload.authorization.value, accept.amount);
  return { code: 0, charged: true, selectedIndex };
}

test("decodes base64 requirements and preserves every accept in server order", () => {
  assert.deepEqual(parsePaymentRequirements(encodedRequirements), requirements);
  assert.deepEqual(
    enumeratePaymentOptions(encodedRequirements).map(({ index, acceptIndex, network }) => ({
      index,
      acceptIndex,
      network,
    })),
    [
      { index: 1, acceptIndex: 0, network: "eip155:8453" },
      { index: 2, acceptIndex: 1, network: "eip155:56" },
      { index: 3, acceptIndex: 2, network: "eip155:999" },
    ]
  );
});

test("rejects malformed or incomplete payment requirements", () => {
  assert.throws(() => parsePaymentRequirements("not+json="), /valid JSON/);
  assert.throws(
    () => parsePaymentRequirements({ x402Version: 2, accepts: [] }),
    /at least one/
  );
  assert.throws(
    () =>
      parsePaymentRequirements({
        x402Version: 2,
        accepts: [{ scheme: "exact" }],
      }),
    /missing network/
  );
});

test("without a wallet, keeps all channels and recommends Binance for returned BSC", () => {
  const plan = planPayment(encodedRequirements, []);
  assert.equal(plan.state, "wallet_required");
  assert.equal(plan.options.length, 3);
  assert.deepEqual(plan.compatibleOptionIndexes, []);
  assert.equal(plan.selectedOptionIndex, null);
  assert.deepEqual(
    plan.setupRecommendations.find(({ id }) => id === "binance-agentic-wallet"),
    {
      id: "binance-agentic-wallet",
      label: "Binance Agentic Wallet",
      recommended: true,
      appliesToOptionIndexes: [2],
    }
  );
});

test("does not claim Binance compatibility when the server returned no BSC option", () => {
  const onlyBase = { ...requirements, accepts: [requirements.accepts[0]] };
  const plan = planPayment(onlyBase, []);
  assert.equal(plan.state, "wallet_required");
  assert.equal(
    plan.setupRecommendations.some(({ id }) => id === "binance-agentic-wallet"),
    false
  );
});

test("one compatible channel still requires confirmation and is not auto-selected", () => {
  const plan = planPayment(requirements, [wallets.base]);
  assert.equal(plan.state, "confirmation_required");
  assert.deepEqual(plan.compatibleOptionIndexes, [1]);
  assert.equal(plan.selectedOptionIndex, null);
});

test("multiple compatible channels require user selection with no default", () => {
  const plan = planPayment(requirements, [wallets.base, wallets.bsc, wallets.future]);
  assert.equal(plan.state, "selection_required");
  assert.deepEqual(plan.compatibleOptionIndexes, [1, 2, 3]);
  assert.equal(plan.selectedOptionIndex, null);
});

test("configured but incompatible or unavailable wallets cannot sign", () => {
  const plan = planPayment(requirements, [
    { id: "wrong", networks: ["eip155:1"] },
    { ...wallets.bsc, available: false },
  ]);
  assert.equal(plan.state, "no_compatible_wallet");
  assert.deepEqual(plan.compatibleOptionIndexes, []);
});

test("wallet matching respects network, scheme, asset, and transfer method", () => {
  const option = enumeratePaymentOptions(requirements)[1];
  assert.equal(walletSupportsOption(wallets.bsc, option), true);
  assert.equal(
    walletSupportsOption({ ...wallets.bsc, schemes: ["upto"] }, option),
    false
  );
  assert.equal(
    walletSupportsOption({ ...wallets.bsc, assets: [requirements.accepts[0].asset] }, option),
    false
  );
  assert.equal(
    walletSupportsOption({ ...wallets.bsc, transferMethods: ["permit2"] }, option),
    false
  );
});

test("wallet address matching is case-insensitive without rewriting returned fields", () => {
  const option = enumeratePaymentOptions(requirements)[1];
  const wallet = { ...wallets.bsc, assets: [option.asset.toLowerCase()] };
  assert.equal(walletSupportsOption(wallet, option), true);
  assert.equal(option.asset, requirements.accepts[1].asset);
});

test("selection requires an explicit valid 1-based option index", () => {
  assert.throws(() => selectPaymentOption(requirements), /explicit 1-based/);
  assert.throws(() => selectPaymentOption(requirements, 0), /does not exist/);
  assert.throws(() => selectPaymentOption(requirements, 4), /does not exist/);
  assert.equal(selectPaymentOption(requirements, 2).network, "eip155:56");
});

for (const [label, selectedIndex] of [
  ["Base channel", 1],
  ["BSC channel", 2],
  ["future server-provided channel", 3],
]) {
  test(`${label} can normalize, encode, and complete a mocked paid replay`, () => {
    const payment = normalizePaymentEnvelope(
      envelopeFor(selectedIndex),
      requirements,
      selectedIndex
    );
    const accept = requirements.accepts[selectedIndex - 1];
    assert.deepEqual(
      { scheme: payment.scheme, network: payment.network },
      { scheme: accept.scheme, network: accept.network }
    );
    assert.deepEqual(
      mockSettle(
        buildPaymentHeader(envelopeFor(selectedIndex), requirements, selectedIndex),
        selectedIndex
      ),
      { code: 0, charged: true, selectedIndex }
    );
  });
}

test("normalization also accepts a base64 wallet envelope", () => {
  const envelope = Buffer.from(JSON.stringify(envelopeFor(2))).toString("base64");
  assert.equal(
    normalizePaymentEnvelope(envelope, encodedRequirements, 2).network,
    requirements.accepts[1].network
  );
});

test("normalization accepts an official envelope without accepted and uses selected accept", () => {
  const envelope = envelopeFor(1);
  delete envelope.accepted;
  const payment = normalizePaymentEnvelope(envelope, requirements, 1);
  assert.equal(payment.scheme, requirements.accepts[0].scheme);
  assert.equal(payment.network, requirements.accepts[0].network);
});

test("rejects cross-channel recipient and amount substitution", () => {
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { authorization: { to: requirements.accepts[1].payTo } }),
        requirements,
        1
      ),
    /authorization.to/
  );
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { authorization: { value: requirements.accepts[1].amount } }),
        requirements,
        1
      ),
    /authorization.value/
  );
});

test("rejects wallet accepted metadata from a different server option", () => {
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { accepted: { network: requirements.accepts[1].network } }),
        requirements,
        1
      ),
    /accepted.network/
  );
});

test("rejects stale protocol version, missing signature, and incomplete authorization", () => {
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { envelope: { x402Version: 1 } }),
        requirements,
        1
      ),
    /x402Version/
  );
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { payload: { signature: "" } }),
        requirements,
        1
      ),
    /missing signature/
  );
  assert.throws(
    () =>
      normalizePaymentEnvelope(
        envelopeFor(1, { authorization: { nonce: "" } }),
        requirements,
        1
      ),
    /missing nonce/
  );
});

test("prevents nonce reuse within a payment session", () => {
  const used = new Set();
  assertUnusedNonce("nonce-1", used);
  assert.throws(() => assertUnusedNonce("nonce-1", used), /already been used/);
  assertUnusedNonce("nonce-2", used);
});

test("paid replay must preserve the exact probability request body", () => {
  const original = { message: "Will X happen?", market_ids: [1, 2] };
  assert.doesNotThrow(() => assertSameProbabilityRequest(original, original));
  assert.throws(
    () => assertSameProbabilityRequest(original, { ...original, market_ids: [2] }),
    /exact original/
  );
});
