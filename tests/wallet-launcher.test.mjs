import assert from "node:assert/strict";
import test from "node:test";

import { runBaw } from "../skills/cournot/scripts/cournot-client.mjs";

test("wallet CLI uses the public command directly outside Windows", () => {
  let invocation;
  const result = runBaw(["wallet", "status"], {
    platform: "linux",
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '{"success":true}' };
    },
  });

  assert.deepEqual(result, { success: true });
  assert.equal(invocation.command, "baw");
  assert.deepEqual(invocation.args, ["wallet", "status", "--json"]);
  assert.equal(invocation.options.shell, false);
  assert.equal("windowsVerbatimArguments" in invocation.options, false);
});

test("wallet CLI runs the public npm command through cmd.exe on Windows", () => {
  const invocations = [];
  const result = runBaw(
    ["x402-payment", "preview", "--paymentRequirements", "eyJhIjoxfQ=="],
    {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
      spawn(command, args, options) {
        invocations.push({ command, args, options });
        if (command === "where.exe") {
          return { status: 0, stdout: "C:\\npm\\baw.cmd\r\n" };
        }
        return { status: 0, stdout: '{"success":true}' };
      },
    }
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(invocations[0].args, ["baw"]);
  const invocation = invocations[1];
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^"baw /);
  assert.match(invocation.args[3], /eyJhIjoxfQ==/);
  assert.match(invocation.args[3], /--json/);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.windowsHide, true);
});

test("missing Windows wallet CLI is reported as unavailable", () => {
  assert.throws(
    () =>
      runBaw(["wallet", "status"], {
        platform: "win32",
        spawn(command) {
          assert.equal(command, "where.exe");
          return { status: 1, stdout: "" };
        },
      }),
    (error) => error.code === "WALLET_UNAVAILABLE"
  );
});

test("Windows wallet launcher rejects line-break command injection", () => {
  let spawnCalls = 0;
  assert.throws(
    () =>
      runBaw(["wallet", "status\r\nwhoami"], {
        platform: "win32",
        spawn() {
          spawnCalls += 1;
        },
      }),
    /cannot contain line breaks/
  );
  assert.equal(spawnCalls, 0);
});
