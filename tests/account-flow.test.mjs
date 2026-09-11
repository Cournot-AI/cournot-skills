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
  createFileIntentStore, prepareProbability, preparePack, executePayment, recoverPack,
} from "../skills/cournot/scripts/cournot-client.mjs";

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

function paymentWallet(counter = {}) {
  return {
    preview() { return { success: true, data: { paymentId: "payment", options: [{
      index: 7, status: "READY_TO_SIGN", originalAccept: route, amount: "0.01", tokenSymbol: "USD1",
    }] } }; },
    sign(_id, index) {
      assert.equal(index, 7); counter.signs = (counter.signs || 0) + 1;
      return { success: true, data: { paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue:
        Buffer.from(JSON.stringify({ x402Version: 2, accepted: route, payload: { signature: "secret-signature",
          authorization: { from: address, to: address, value: route.amount, validAfter: "0", validBefore: "9999999999", nonce: "secret-nonce" },
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
    assert.ok(data.presentation.includes(`](${base})`));
    assert.equal(data.presentation.includes("$0.01"), base === DEV_BASE);
    assert.match(data.presentation, /最新付款预览/);
    assert.match(data.presentation, /你想选择哪个套餐/);
    assert.match(data.presentation, /失去钱包访问权和密钥/);
  }
});
