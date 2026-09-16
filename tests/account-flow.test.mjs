import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_BASE, PRODUCTION_BASE, apiBase, apiRequest, createCredentials, readAccount,
  prepareAccountAuth, executeAccountAuth, sanitize,
} from "../skills/cournot/scripts/account-flow.mjs";
import {
  createFileIntentStore, prepareProbability, preparePack, executePayment as executePaymentReal, recoverPack as recoverPackReal,
} from "../skills/cournot/scripts/cournot-client.mjs";

function withClock(operation, options) {
  let clock = Date.now();
  return operation({ now: () => clock, wait: async (ms) => { clock += ms; }, ...options });
}
const executePayment = (options) => withClock(executePaymentReal, options);
const recoverPack = (options) => withClock(recoverPackReal, options);

const key = "ck_live_test_key_1234";
const otherKey = "ck_live_test_key_5678";
const address = "0x1111111111111111111111111111111111111111";
const request = { message: "Will BTC reach $200,000 in 2027?", market_ids: [1] };
const balance = { total: 600, used: 1, remaining: 599 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const account = (api_key = key) => json({ code: 0, data: { api_key, wallet: address, balance } });
const route = { scheme: "exact", network: "eip155:56", amount: "10000000000000000", asset: address, payTo: address };
const requirements = { x402Version: 2, resource: { url: "" }, accepts: [route] };
const challenge = () => new Response(null, { status: 402, headers: {
  "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(requirements)).toString("base64"),
} });

function fixture(t, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cournot-account-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, credentials: createCredentials({ directory, env }),
    intents: createFileIntentStore({ directory: join(directory, "intents") }) };
}

function paymentWallet(counter = {}, authorizationOverrides = {}) {
  return {
    preview() { return { success: true, data: { paymentId: "payment", options: [{
      index: 7, status: "READY_TO_SIGN", originalAccept: route, amount: "0.01", tokenSymbol: "USD1",
    }] } }; },
    sign(_id, index) {
      assert.equal(index, 7); counter.signs = (counter.signs || 0) + 1;
      return { success: true, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue:
        Buffer.from(JSON.stringify({ x402Version: 2, accepted: route, payload: { signature: "secret-signature",
          authorization: { from: address, to: address, value: route.amount, validAfter: "0", validBefore: "9999999999", nonce: "secret-nonce", ...authorizationOverrides },
        } })).toString("base64"),
      } };
    },
  };
}

function authWallet({ pending = false, developerMode = true } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    let data;
    if (command === "wallet status") data = { status: "CONNECTED" };
    else if (command === "wallet settings") data = { devMode: { enabled: developerMode } };
    else if (command === "wallet address") data = { addresses: [{ binanceChainId: "1", address }] };
    else if (command === "sign-message preview") {
      assert.equal(args[args.indexOf("--signType") + 1], "EIP712");
      const wrapper = JSON.parse(args[args.indexOf("--message") + 1]);
      assert.equal(wrapper.method, "eth_signTypedData_v4");
      assert.equal(wrapper.params[0], address);
      const typed = JSON.parse(wrapper.params[1]);
      assert.deepEqual(typed.domain, { name: "Cournot", version: "1", chainId: 1 });
      assert.equal(typed.primaryType, "WalletAuth");
      assert.equal(typeof typed.message.timestamp, "string");
      data = { requestId: "auth-preview", expiresAt: Date.now() + 300_000, parsedMessage: typed.message, risks: {} };
    } else if (command === "sign-message execute" && pending) data = { status: "PENDING_CONFIRMATION", orderId: "order" };
    else if (["sign-message execute", "sign-message result"].includes(command)) data = { status: "COMPLETED", signature: "ab".repeat(64), signatureRecovery: "01" };
    else assert.fail(`Unexpected wallet operation: ${command}`);
    return { success: true, data };
  };
  return { run, calls };
}

test("credentials persist per origin, env overrides only its bound origin, and writes are private", (t) => {
  const env = { COURNOT_API_KEY: otherKey };
  const { credentials, directory } = fixture(t, env);
  assert.equal(apiBase(), DEV_BASE);
  assert.throws(() => apiBase("https://attacker.invalid"), /Unsupported/);
  assert.throws(() => apiBase(`${DEV_BASE}/other`), /Unsupported/);
  const saved = credentials.save(DEV_BASE, key);
  assert.equal(saved.active, false);
  assert.equal(credentials.read(DEV_BASE).key, otherKey);
  assert.equal(credentials.read(PRODUCTION_BASE).key, null);
  credentials.save(PRODUCTION_BASE, key);
  env.COURNOT_API_KEY_BASE = PRODUCTION_BASE;
  assert.equal(credentials.read(PRODUCTION_BASE).key, otherKey);
  assert.equal(credentials.read(DEV_BASE).key, key);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(key));
  const folder = join(directory, "credentials");
  if (process.platform !== "win32") {
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    for (const f of readdirSync(folder)) assert.equal(statSync(join(folder, f)).mode & 0o777, 0o600);
  }
  assert.equal(readdirSync(folder).length, 2);
});

test("import validates before saving, supports manual keys, and reveals only on explicit key read", async (t) => {
  const { credentials } = fixture(t);
  credentials.save(DEV_BASE, key);
  for (const importKey of ["", " \n\t"]) {
    await assert.rejects(readAccount({ credentials, importKey,
      fetchImpl: async () => assert.fail("Empty import must not query the saved key"),
    }), { code: "INVALID_KEY_FORMAT" });
    assert.equal(credentials.read(DEV_BASE).key, key);
  }
  const invalid = await readAccount({ credentials, importKey: otherKey,
    fetchImpl: async () => json({ code: 4100, msg: "api key is invalid" }) });
  assert.equal(invalid.state, "key_invalid");
  assert.equal(credentials.read(DEV_BASE).key, key);
  const kol = "ck_live_kol_example";
  const imported = await readAccount({ credentials, importKey: kol, fetchImpl: async (_url, init) => {
    assert.equal(init.headers["COURNOT-API-KEY"], kol);
    assert.equal(init.redirect, "error");
    return json({ code: 0, data: { api_key: kol, wallet: "", balance } });
  } });
  assert.equal(imported.saved, true);
  assert.equal(imported.wallet, null);
  assert.doesNotMatch(JSON.stringify(imported), new RegExp(kol));
  const shown = await readAccount({ credentials, reveal: true, fetchImpl: async () => account(kol) });
  assert.equal(shown.api_key, kol);
  assert.match(shown.secrecyWarning, /secret/);
  assert.equal(credentials.read(DEV_BASE).key, kol);
});

test("corrupt credential file fails closed rather than switching billing", (t) => {
  const { credentials, directory } = fixture(t);
  credentials.save(DEV_BASE, key);
  writeFileSync(join(directory, "credentials", readdirSync(join(directory, "credentials"))[0]), "invalid");
  assert.throws(() => credentials.read(DEV_BASE), /Cannot read/);
  assert.doesNotMatch(JSON.stringify(sanitize({ msg: `invalid ${key}`, nested: { api_key: key } })), new RegExp(key));
});

test("free, prepaid and exhausted responses never touch a wallet or silently retry", async (t) => {
  const { credentials, intents } = fixture(t);
  credentials.save(DEV_BASE, key);
  const cases = [
    [json({ code: 0, data: { billing: "free_quota", charged: false, free_quota: { remaining: 2 }, api_key_quota: null } }), "complete"],
    [json({ code: 0, data: { billing: "api_key", charged: false, api_key_quota: balance } }), "complete"],
    [json({ code: 22002, msg: "api key quota exhausted" }), "pack_exhausted"],
    [json({ code: 4100, msg: "api key is invalid" }), "key_invalid"],
    [json({ code: 4100, msg: "market_ids is required" }), "api_error"],
    [json({}, 429), "rate_limited"],
    [json({}, 500), "service_error"],
  ];
  for (const [response, expected] of cases) {
    let calls = 0;
    const output = await prepareProbability({ request, credentials, intents, wallet: { preview() { assert.fail("Wallet touched"); } },
      fetchImpl: async (_url, init) => { calls++; assert.equal(init.headers["COURNOT-API-KEY"], key); return response; } });
    assert.equal(output.state, expected); assert.equal(calls, 1);
    if (output.response?.data?.billing === "api_key") assert.equal(output.response.data.api_key_quota.remaining, 599);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(key));
  }
});

test("anonymous 402 offers three choices; explicit per-call bypasses key for this request only", async (t) => {
  const { credentials, intents } = fixture(t);
  const choice = await prepareProbability({ request, credentials, intents, fetchImpl: async () => challenge(), wallet: {} });
  assert.deepEqual(choice.choices, ["topup", "import", "per_call"]);
  credentials.save(DEV_BASE, key);
  const prepared = await prepareProbability({ request, credentials, intents, perCall: true, wallet: paymentWallet(),
    fetchImpl: async (_url, init) => { assert.equal(init.headers["COURNOT-API-KEY"], undefined); return challenge(); } });
  assert.equal(prepared.state, "payment_confirmation_required");
  assert.equal(credentials.read(DEV_BASE).key, key);
  assert.doesNotMatch(JSON.stringify(prepared), /secret-signature|secret-nonce/);
});

test("pack confirmation pins environment, SKU, amount and selected wallet option", async (t) => {
  const { credentials, intents } = fixture(t); const count = {}; const wallet = paymentWallet(count);
  let requests = 0;
  const prepared = await preparePack({ packId: "p20", intents, wallet, fetchImpl: async (url, init) => {
    assert.equal(url, `${DEV_BASE}/intelligence/v1/packs`);
    assert.deepEqual(JSON.parse(init.body), { pack_id: "p20" }); return challenge();
  } });
  assert.equal(prepared.pack.price_usd, 20);
  assert.equal(prepared.serverOptions[0].amountLabel, "0.01 USD1");
  const options = { intentId: prepared.intentId, selectedOption: 1, intents, credentials, wallet,
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url, `${DEV_BASE}/intelligence/v1/packs`);
      assert.deepEqual(JSON.parse(init.body), { pack_id: "p20" });
      assert.ok(init.headers["PAYMENT-SIGNATURE"]);
      return json({ code: 0, data: { api_key: key, balance, pack: { pack_id: "p20", calls: 2800 }, charged: true } });
    } };
  await assert.rejects(executePayment({ ...options, confirmed: false }), /confirmation/);
  await assert.rejects(executePayment({ ...options, confirmed: true, base: PRODUCTION_BASE }), /environment/);
  assert.equal(count.signs || 0, 0);
  const result = await executePayment({ ...options, confirmed: true });
  assert.equal(result.saved, true); assert.equal(result.balance.remaining, 599);
  assert.equal(credentials.read(DEV_BASE).key, key);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.equal(requests, 1); assert.equal(count.signs, 1);
  await assert.rejects(executePayment({ ...options, confirmed: true }), /already used/);
});

test("uncertain purchase preserves exact payment for explicit recovery without a new signature", async (t) => {
  const { credentials, intents } = fixture(t); const count = {}; const wallet = paymentWallet(count);
  const prepared = await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() });
  let original;
  const unknown = await executePayment({ intentId: prepared.intentId, selectedOption: 1, confirmed: true, intents, credentials, wallet,
    fetchImpl: async (url, init) => { original = { url, body: init.body, headers: init.headers }; throw new Error("timeout"); } });
  assert.equal(unknown.state, "purchase_unknown");
  await assert.rejects(recoverPack({ intentId: unknown.recoveryId, intents }), /confirmation/);
  const result = await recoverPack({ intentId: unknown.recoveryId, confirmed: true, intents, credentials,
    fetchImpl: async (url, init) => { assert.deepEqual({ url, body: init.body, headers: init.headers }, original); return account(); } });
  assert.equal(result.saved, true); assert.equal(count.signs, 1);
});

test("EIP-3009 chain timing: immediate success, not-yet-valid recovery, and expiry", async (t) => {
  for (const [label, offset] of [["already valid", 1], ["chain behind", -2], ["equal timestamp", 0], ["expired", 60]]) {
    await t.test(label, async (t) => {
      const { credentials, intents } = fixture(t);
      const count = {};
      const validAfter = Math.floor(Date.now() / 1000);
      const wallet = paymentWallet(count, { validAfter: String(validAfter), validBefore: String(validAfter + 60) });
      const prepared = await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() });
      let chainTimestamp = validAfter + offset;
      let submissions = 0;
      let original;
      // Simulate the settlement precheck against chain time, without sleeping or paying.
      const fetchImpl = async (url, init) => {
        submissions++;
        const submitted = { url, body: init.body, headers: init.headers };
        if (original) assert.deepEqual(submitted, original);
        else original = structuredClone(submitted);
        const { authorization, signature } = JSON.parse(Buffer.from(init.headers["PAYMENT-SIGNATURE"], "base64").toString()).payload;
        assert.equal(signature, "secret-signature");
        assert.equal(authorization.validAfter, String(validAfter));
        assert.equal(authorization.validBefore, String(validAfter + 60));
        assert.equal(authorization.nonce, "secret-nonce");
        assert.equal(authorization.value, route.amount);
        return chainTimestamp > Number(authorization.validAfter) && chainTimestamp < Number(authorization.validBefore)
          ? account()
          : json({ code: 22000, msg: "invalid_transaction_state" });
      };
      const result = await executePayment({ intentId: prepared.intentId, selectedOption: 1, confirmed: true,
        intents, credentials, wallet, fetchImpl });
      assert.equal(submissions, 1); // No automatic retries on the generic settlement error.
      assert.equal(count.signs, 1);
      if (offset === 1) {
        assert.equal(result.saved, true);
        return;
      }
      assert.equal(result.state, "purchase_unknown");
      assert.equal(credentials.read(DEV_BASE).key, null);
      await assert.rejects(recoverPack({ intentId: result.recoveryId, intents, credentials, fetchImpl }), /confirmation/);
      assert.equal(submissions, 1);
      chainTimestamp += 3;
      const recovered = await recoverPack({ intentId: result.recoveryId, confirmed: true, intents, credentials, fetchImpl });
      assert.equal(submissions, 2);
      assert.equal(count.signs, 1);
      if (offset === 60) {
        // Waiting cannot fix expiry; a server rejection must remain unconfirmed.
        assert.equal(recovered.state, "purchase_unknown");
        assert.equal(credentials.read(DEV_BASE).key, null);
      } else {
        assert.equal(recovered.saved, true);
        assert.equal(credentials.read(DEV_BASE).key, key);
      }
    });
  }
});

test("only explicit not-yet-valid failures retry once within the confirmed payment", async (t) => {
  const cases = [
    { name: "success", first: "success", calls: 1 },
    { name: "explicit reason", calls: 2, saved: true },
    { name: "contract revert reason", msg: "EIP3009: authorization is not yet valid", calls: 2, saved: true },
    { name: "generic error", msg: "invalid_transaction_state", calls: 1 },
    { name: "still invalid after retry", repeat: true, calls: 2 },
    { name: "network failure", first: "network", calls: 1 },
    { name: "expires during wait", before: "1003", calls: 1 },
    { name: "future authorization", after: "1008", calls: 1 },
    { name: "malformed timestamp", after: "NaN", calls: 1 },
    { name: "retry wait overshoots expiry", overshoot: true, calls: 1, waits: 2 },
    { name: "service unavailable", status: 503, calls: 1 },
    { name: "contradictory charge evidence", data: { charged: true }, calls: 1 },
  ];
  for (const path of ["packs", "probability"]) for (const scenario of cases) {
    await t.test(`${path}: ${scenario.name}`, async (t) => {
      const { credentials, intents } = fixture(t);
      const count = {};
      const wallet = paymentWallet(count, { validAfter: scenario.after ?? "1000", validBefore: scenario.before ?? "1060" });
      const prepared = path === "packs"
        ? await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() })
        : await prepareProbability({ request, perCall: true, intents, credentials, wallet, fetchImpl: async () => challenge() });
      let clock = 997000;
      let calls = 0;
      let waits = 0;
      let original;
      const options = { intentId: prepared.intentId, selectedOption: 1, confirmed: true, intents, credentials, wallet,
        now: () => clock, wait: async (ms) => {
          waits++;
          assert.equal(ms, 3000);
          clock += scenario.overshoot && waits > 1 ? 60000 : ms;
        },
        fetchImpl: async (url, init) => {
          calls++;
          const submitted = { url, body: init.body, headers: init.headers };
          if (original) assert.deepEqual(submitted, original);
          else original = structuredClone(submitted);
          if (scenario.first === "network") throw new Error("network failure");
          if (scenario.first === "success" || (calls === 2 && !scenario.repeat)) return account();
          return json({ code: 22000, msg: scenario.msg ?? "authorization_not_yet_valid", data: scenario.data }, scenario.status ?? 200);
        } };
      if (path === "probability" && scenario.first === "network") {
        await assert.rejects(executePayment(options), /network failure/);
      } else {
        const result = await executePayment(options);
        const success = scenario.first === "success" || scenario.saved;
        if (path === "packs" && success) assert.equal(result.saved, true);
        else assert.equal(result.state, success ? "complete" : path === "packs" ? "purchase_unknown" : "payment_failed");
      }
      assert.equal(calls, scenario.calls);
      assert.equal(waits, scenario.waits ?? (scenario.calls === 2 ? 2 : 1));
      assert.equal(count.signs, 1);
    });
  }
});

test("purchase success with local save failure reports recovery instead of another payment", async (t) => {
  const { intents } = fixture(t); const wallet = paymentWallet();
  const prepared = await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() });
  const result = await executePayment({ intentId: prepared.intentId, selectedOption: 1, confirmed: true, intents, wallet,
    credentials: { save() { throw new Error("Disk full"); } }, fetchImpl: async () => account() });
  assert.equal(result.state, "credential_save_failed");
  assert.match(result.next, /do not buy again/); assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
});

test("EIP-712 recovery uses fixed typed data, normalizes 64+1 bytes, verifies wallet and masks key", async (t) => {
  const { intents, credentials } = fixture(t); const { run, calls } = authWallet();
  const prepared = prepareAccountAuth({ action: "account", run, intents });
  const previewArgs = calls.find(args => args[1] === "preview");
  const signedData = JSON.parse(JSON.parse(previewArgs[previewArgs.indexOf("--message") + 1]).params[1]);
  assert.doesNotMatch(JSON.stringify(prepared), /parsedMessage|primaryType|domain|nonce|timestamp|urlPath/);
  const options = { intentId: prepared.intentId, run, intents, credentials, fetchImpl: async (url, init) => {
    assert.equal(url, `${DEV_BASE}/intelligence/v1/account`); assert.equal(init.method, "GET");
    assert.equal(init.headers["X-COURNOT-SIGNATURE"], `0x${"ab".repeat(64)}01`);
    assert.equal(init.headers["X-COURNOT-NONCE"], signedData.message.nonce);
    return account();
  } };
  await assert.rejects(executeAccountAuth({ ...options, confirmed: false }), /confirmation/);
  const result = await executeAccountAuth({ ...options, confirmed: true });
  assert.equal(result.saved, true); assert.equal(credentials.read(DEV_BASE).key, key);
  assert.doesNotMatch(JSON.stringify(result), /abababab|"api_key"/);
  assert.equal(calls.filter((x) => x[1] === "execute").length, 1);
});

test("rotation waits for user confirmation and App completion without signing twice", async (t) => {
  const { intents, credentials } = fixture(t); const { run, calls } = authWallet({ pending: true });
  credentials.save(DEV_BASE, key);
  const prepared = prepareAccountAuth({ action: "rotate", run, intents });
  assert.match(prepared.warning, /every device/);
  assert.doesNotMatch(JSON.stringify(prepared), /parsedMessage|primaryType|domain|nonce|timestamp|urlPath/);
  const previewArgs = calls.find(args => args[1] === "preview");
  const signedData = JSON.parse(JSON.parse(previewArgs[previewArgs.indexOf("--message") + 1]).params[1]);
  assert.equal(signedData.message.urlPath, "/intelligence/v1/key/rotate");
  let posts = 0;
  const options = { intents, credentials, run, fetchImpl: async (url, init) => {
    posts++; assert.equal(url, `${DEV_BASE}/intelligence/v1/key/rotate`); assert.equal(init.method, "POST");
    assert.equal(init.body, undefined); return account(otherKey);
  } };
  const pending = await executeAccountAuth({ ...options, intentId: prepared.intentId, confirmed: true });
  assert.equal(pending.state, "signature_pending"); assert.equal(posts, 0);
  const result = await executeAccountAuth({ ...options, intentId: pending.intentId, poll: true });
  assert.equal(result.saved, true); assert.equal(posts, 1);
  assert.equal(credentials.read(DEV_BASE).key, otherKey);
  assert.equal(calls.filter((x) => x[1] === "execute").length, 1);
  assert.equal(calls.filter((x) => x[1] === "result").length, 1);
});

test("rotation failure and wrong-wallet results never replace a credential or retry", async (t) => {
  const { intents, credentials } = fixture(t); const { run } = authWallet();
  credentials.save(DEV_BASE, key);
  for (const response of [() => json({ code: 22004, msg: "manual api key can not be rotated" }), () => { throw new Error("timeout"); }]) {
    const prepared = prepareAccountAuth({ action: "rotate", run, intents });
    let calls = 0;
    const result = await executeAccountAuth({ intentId: prepared.intentId, confirmed: true, intents, credentials, run,
      fetchImpl: async () => { calls++; return response(); } });
    assert.ok(["api_error", "account_result_unknown"].includes(result.state));
    assert.equal(calls, 1); assert.equal(credentials.read(DEV_BASE).key, key);
  }
  const prepared = prepareAccountAuth({ action: "account", run, intents });
  await assert.rejects(executeAccountAuth({ intentId: prepared.intentId, confirmed: true, intents, credentials, run,
    fetchImpl: async () => json({ code: 0, data: { api_key: otherKey, wallet: "0xwrong", balance } }) }), /did not match/);
  assert.equal(credentials.read(DEV_BASE).key, key);
});

test("developer-mode-disabled never previews or executes a signature", (t) => {
  const { intents } = fixture(t); const { run, calls } = authWallet({ developerMode: false });
  const result = prepareAccountAuth({ action: "account", run, intents });
  assert.equal(result.state, "developer_mode_required");
  assert.equal(calls.some((x) => x[0] === "sign-message"), false);
});

test("HTTP client refuses redirects and invalid origins before exposing credentials", async () => {
  let calls = 0;
  await assert.rejects(apiRequest({ base: "https://untrusted.invalid", path: "account", fetchImpl: async () => { calls++; } }), /Unsupported/);
  assert.equal(calls, 0);
  await apiRequest({ path: "account", fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, "error"); assert.ok(init.signal); return account();
  } });
});


test("CLI runs through an absolute symlinked path instead of silently skipping main", { skip: process.platform === "win32" }, (t) => {
  const { directory } = fixture(t);
  const source = fileURLToPath(new URL("../skills/cournot/scripts", import.meta.url));
  const alias = join(directory, "linked-scripts");
  symlinkSync(source, alias, "dir");
  const result = spawnSync(process.execPath, [join(alias, "cournot-client.mjs"), "packs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.state, "pack_selection_required");
  assert.equal(data.packs.length, 3);
});

test("evaluation storage and request headers stay isolated from real environments", async (t) => {
  const { directory, credentials } = fixture(t);
  credentials.save(DEV_BASE, key);
  const isolated = createCredentials({ env: { COURNOT_CREDENTIAL_DIR: directory } });
  assert.equal(isolated.read(DEV_BASE).key, key);
  const previous = process.env.COURNOT_EVAL_ID;
  process.env.COURNOT_EVAL_ID = "isolated-case";
  try {
    for (const base of [DEV_BASE, PRODUCTION_BASE, "http://127.0.0.1:8765"]) {
      await apiRequest({ base, path: "account", fetchImpl: async (_url, init) => {
        assert.equal(init.headers["X-Eval-Id"], base.startsWith("http://127.") ? "isolated-case" : undefined);
        return account();
      } });
    }
  } finally {
    if (previous === undefined) delete process.env.COURNOT_EVAL_ID;
    else process.env.COURNOT_EVAL_ID = previous;
  }
});


test("pack selection shows the development discount only for the development origin", () => {
  const client = fileURLToPath(new URL("../skills/cournot/scripts/cournot-client.mjs", import.meta.url));
  for (const base of [DEV_BASE, PRODUCTION_BASE, "http://127.0.0.1:8765"]) {
    const result = spawnSync(process.execPath, [client, "packs", "--language", "zh"], {
      env: { ...process.env, COURNOT_API_BASE: base }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.base, base);
    assert.ok(!data.presentation.includes(base));
    assert.doesNotMatch(data.presentation, /开发环境|正式环境|生产环境|自定义环境|Active environment|development|production|localhost/);
    assert.equal(data.presentation.includes("$0.01"), base === DEV_BASE);
    assert.match(data.presentation, /最新付款预览/);
    assert.match(data.presentation, /你想选择哪个套餐/);
    assert.match(data.presentation, /失去钱包访问权和密钥/);
  }
});

test("paid submissions wait after signing, preserve errors, and never send expired authorizations", async (t) => {
  const cases = [
    { name: "success", before: "1060", calls: 1, waits: 1 },
    { name: "already expired", before: "1000", calls: 0, waits: 0, expired: true },
    { name: "expiry equals end of delay", before: "1003", calls: 0, waits: 0, expired: true },
    { name: "expiry just beyond delay", before: "1004", calls: 1, waits: 1 },
    { name: "timer overshoots expiry", before: "1060", calls: 0, waits: 1, overshoot: true, expired: true },
    { name: "business rejection", before: "1060", calls: 1, waits: 1, rejected: true },
    { name: "transport failure", before: "1060", calls: 1, waits: 1, transport: true },
    { name: "delay interrupted", before: "1060", calls: 0, waits: 1, interrupted: true },
  ];
  for (const path of ["probability", "packs"]) for (const c of cases) {
    await t.test(`${path}: ${c.name}`, async (t) => {
      const { credentials, intents } = fixture(t);
      let clock = 1000000, waits = 0, submissions = 0;
      const events = [], count = {};
      const signingWallet = paymentWallet(count, { validAfter: "999", validBefore: c.before });
      const wallet = { ...signingWallet, sign(...args) { events.push("sign"); return signingWallet.sign(...args); } };
      const prepared = path === "packs"
        ? await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() })
        : await prepareProbability({ request, perCall: true, intents, credentials, wallet, fetchImpl: async () => challenge() });
      const options = { intentId: prepared.intentId, selectedOption: 1, confirmed: true, intents, credentials, wallet,
        now: () => clock,
        wait: async (ms) => {
          events.push("wait"); waits++; assert.equal(ms, 3000);
          if (c.interrupted) throw Object.assign(new Error("test wait interrupted"), { code: "TEST_WAIT_INTERRUPTED" });
          clock += c.overshoot ? 60000 : ms;
        },
        fetchImpl: async () => {
          events.push("submit"); submissions++; assert.equal(clock, 1003000); clock += 25;
          if (c.transport) throw Object.assign(new Error("test connection timeout"), { cause: { code: "ETIMEDOUT" } });
          if (c.rejected) return json({ code: 22000, msg: "invalid_transaction_state" }, 400);
          return account();
        },
      };
      let result, failure;
      try { result = await executePayment(options); } catch (error) { failure = error; }
      assert.equal("diagnostics" in (result ?? failure), false);
      assert.equal(count.signs, 1); assert.equal(waits, c.waits); assert.equal(submissions, c.calls);
      assert.doesNotMatch(JSON.stringify(result ?? failure), /secret-signature|secret-nonce|paymentHeader/);
      if (c.calls) {
        assert.deepEqual(events, ["sign", "wait", "submit"]);
      }
      if (c.expired) assert.equal(failure?.code ?? result.error.code, "PAYMENT_AUTHORIZATION_EXPIRED");
      else if (c.transport) {
        assert.equal(failure?.cause?.code ?? result.error.code, "ETIMEDOUT");
        assert.equal(failure?.message ?? result.error.message, "test connection timeout");
      }
      else if (c.interrupted) assert.equal(failure?.code ?? result.error.code, "TEST_WAIT_INTERRUPTED");
      else if (c.rejected) {
        assert.equal(result.httpStatus, 400); assert.equal(result.response.code, 22000);
        assert.equal(result.response.msg, "invalid_transaction_state");
      } else assert.equal(path === "packs" ? result.saved : result.state === "complete", true);
      await assert.rejects(executePayment(options), /already used/);
    });
  }
});

test("pack recovery applies its own delay without signing again and keeps transport errors", async (t) => {
  const { credentials, intents } = fixture(t); const count = {}, wallet = paymentWallet(count);
  const prepared = await preparePack({ packId: "p5", intents, wallet, fetchImpl: async () => challenge() });
  let clock = 1000000; const waits = [], requests = [];
  const common = { intents, credentials, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } };
  const first = await executePayment({ ...common, intentId: prepared.intentId, selectedOption: 1, confirmed: true, wallet,
    fetchImpl: async (url, init) => { requests.push({ url, ...init }); throw Object.assign(new Error("test timeout"), { code: "ETIMEDOUT" }); } });
  assert.equal(first.state, "purchase_unknown"); assert.equal(first.error.code, "ETIMEDOUT");
  assert.equal(first.error.message, "test timeout");
  const result = await recoverPack({ ...common, intentId: first.recoveryId, confirmed: true,
    fetchImpl: async (url, init) => {
      assert.equal(url, requests[0].url); assert.equal(init.body, requests[0].body);
      assert.deepEqual(init.headers, requests[0].headers); return account();
    } });
  assert.deepEqual(waits, [3000, 3000]); assert.equal(count.signs, 1); assert.equal(result.saved, true);
});

test("signing and approval failures never wait or submit", async (t) => {
  for (const stage of ["sign", "approval", "validate"]) await t.test(stage, async (t) => {
    const { credentials, intents } = fixture(t); const baseWallet = paymentWallet();
    const prepared = await prepareProbability({ request, perCall: true, intents, credentials, wallet: baseWallet, fetchImpl: async () => challenge() });
    const wallet = { ...baseWallet, sign(...args) {
      if (stage === "sign") throw Object.assign(new Error("wallet unavailable"), { code: "WALLET_UNAVAILABLE" });
      const result = baseWallet.sign(...args);
      if (stage === "approval") result.data.approveTxHash = "0xapproval";
      if (stage === "validate") result.data.paymentHeaderValue = Buffer.from('{}').toString('base64');
      return result;
    }, waitForApproval: async () => false };
    const options = { intentId: prepared.intentId, selectedOption: 1, confirmed: true, intents, credentials, wallet,
      wait: async () => assert.fail("must not wait"), fetchImpl: async () => assert.fail("must not submit") };
    if (stage === "approval") {
      const result = await executePayment(options);
      assert.equal(result.state, "approval_pending");
    } else await assert.rejects(executePayment(options), error => {
      assert.equal(error.code, stage === "sign" ? "WALLET_UNAVAILABLE" : "PAYMENT_MISMATCH"); return true;
    });
    await assert.rejects(executePayment(options), /already used/);
  });
});

test("concurrent confirmed payments have independent waits", async (t) => {
  const { credentials, intents } = fixture(t); const counter = {}, wallet = paymentWallet(counter);
  const prepared = await Promise.all([1, 2].map(() => prepareProbability({ request, perCall: true, intents, credentials, wallet, fetchImpl: async () => challenge() })));
  const releases = []; let calls = 0;
  const pending = prepared.map((p) => {
    let clock = 1000000;
    return executePayment({ intentId: p.intentId, selectedOption: 1, confirmed: true, intents, credentials, wallet,
      now: () => clock, wait: ms => new Promise(resolve => { assert.equal(ms, 3000); releases.push(() => { clock += ms; resolve(); }); }),
      fetchImpl: async () => { calls++; return json({ code: 0, data: { charged: true } }); } });
  });
  assert.equal(releases.length, 2); assert.equal(calls, 0); assert.equal(counter.signs, 2);
  releases.forEach(release => release());
  const results = await Promise.all(pending);
  assert.equal(calls, 2);
  for (const r of results) {
    assert.equal(r.state, "complete");
  }
});

test("production payment keeps its origin, terms and body through the initial delay", async (t) => {
  const { credentials, intents } = fixture(t); const wallet = paymentWallet();
  const prepared = await prepareProbability({ base: PRODUCTION_BASE, request, perCall: true, intents, credentials, wallet,
    fetchImpl: async url => { assert.equal(url, `${PRODUCTION_BASE}/intelligence/v1/probability`); return challenge(); } });
  let clock = 1000000, waited = false;
  const result = await executePayment({ base: PRODUCTION_BASE, intentId: prepared.intentId, selectedOption: 1, confirmed: true,
    intents, credentials, wallet, now: () => clock, wait: async ms => { assert.equal(ms, 3000); waited = true; clock += ms; },
    fetchImpl: async (url, init) => {
      assert.equal(waited, true); assert.equal(url, `${PRODUCTION_BASE}/intelligence/v1/probability`);
      assert.deepEqual(JSON.parse(init.body), request);
      const payment = JSON.parse(Buffer.from(init.headers['PAYMENT-SIGNATURE'], 'base64').toString());
      assert.equal(payment.payload.authorization.to, route.payTo); assert.equal(payment.payload.authorization.value, route.amount);
      return json({ code: 0, data: { charged: true } });
    } });
  assert.equal(result.state, "complete");
});
