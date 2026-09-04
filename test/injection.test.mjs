// Behavioral + unit tests for the provider-routing injection.
//
// The behavioral tests build a sandboxed sendRequest/prewarmThreadStart pair
// from the real SEND_INJECT_TEMPLATE / PREWARM_INJECT_TEMPLATE (exactly the
// code that gets written into the app bundle), stub the IPC helper, and assert
// the routing decisions for every supported scenario.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

import {
  SEND_INJECT_TEMPLATE,
  PREWARM_INJECT_TEMPLATE,
  MARKER_TEXT,
  asarHeaderHash,
  asarIntegrityHash,
  loadPlist,
} from "../lib/patcher.mjs";

test("asar header hash matches the installed app's integrity metadata", () => {
  const app = "/Applications/ChatGPT.app";
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(asarPath)) return test.skip("app bundle not present on this machine", () => {});
  const { info } = loadPlist(path.join(app, "Contents", "Info.plist"));
  assert.equal(asarHeaderHash(asarPath), asarIntegrityHash(info));
});

const IPC_HELPER = "ED";
const SEND_INJECTION = SEND_INJECT_TEMPLATE.replaceAll("@IPC@", IPC_HELPER);
const PREWARM_INJECTION = PREWARM_INJECT_TEMPLATE.replaceAll("@IPC@", IPC_HELPER);

const ROUTING = {
  model_providers: {
    "glm-5.3-flash": "openrouter",
    "glm-5.3": "openrouter",
    "deepseek-v4-flash": "deepseek",
    "deepseek-v4-pro": "deepseek",
    "MiniMax-M2.7-highspeed": "minimax",
    "MiniMax-M3": "minimax",
  },
  default_provider: "openai",
};

function makeRunner({ ipcFails = false } = {}) {
  const source = `
    async function sendRequest(e, t, n) {
      if (this.dispatchMessage == null) throw Error('no dispatcher');
      ${SEND_INJECTION}
      return { method: e, payload: t };
    }
    async function prewarmThreadStart(e, t) {
      if (this.dispatchMessage == null) throw Error('no dispatcher');
      ${PREWARM_INJECTION}
      return { payload: e };
    }
  `;
  const sandbox = {
    ED: async (method) => {
      if (ipcFails) throw new Error("boom");
      if (method === "codex-home") return { codexHome: "/tmp/fakehome" };
      if (method === "read-file") return { contents: JSON.stringify(ROUTING) };
      throw new Error(`unexpected IPC method: ${method}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  const ctx = { dispatchMessage: {}, hostId: "local" };
  return {
    send: (method, payload) => sandbox.sendRequest.call(ctx, method, payload),
    prewarm: (payload) => sandbox.prewarmThreadStart.call(ctx, payload),
  };
}

test("thread/start maps glm-5.3-flash to openrouter", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/start", { model: "glm-5.3-flash" });
  assert.equal(result.payload.modelProvider, "openrouter");
});

test("thread/settings/update swaps back to the default provider for native models", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/settings/update", { threadId: "t1", model: "gpt-5.6-terra" });
  assert.equal(result.payload.modelProvider, "openai");
});

test("thread/settings/update swaps to the mapped provider for custom models", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/settings/update", { threadId: "t1", model: "glm-5.3" });
  assert.equal(result.payload.modelProvider, "openrouter");
});

test("settings update without a model is left untouched", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/settings/update", {
    threadId: "t1",
    sandboxPolicy: { type: "read-only" },
  });
  assert.equal("modelProvider" in result.payload, false);
});

test("explicit modelProvider is preserved", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/settings/update", {
    threadId: "t1",
    model: "deepseek-v4-pro",
    modelProvider: "custom-override",
  });
  assert.equal(result.payload.modelProvider, "custom-override");
});

test("turn/settings/update is also routed", async () => {
  const runner = makeRunner();
  const result = await runner.send("turn/settings/update", { threadId: "t1", model: "MiniMax-M3" });
  assert.equal(result.payload.modelProvider, "minimax");
});

test("thread/list gets an empty modelProviders filter", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/list", null);
  assert.equal(result.payload.modelProviders?.length, 0);
});

test("config/read is untouched", async () => {
  const runner = makeRunner();
  const result = await runner.send("config/read", { id: "x" });
  assert.equal("modelProvider" in result.payload, false);
});

test("prewarmThreadStart routes custom and native models", async () => {
  const runner = makeRunner();
  const custom = await runner.prewarm({ model: "MiniMax-M3" });
  const native = await runner.prewarm({ model: "gpt-5.6-luna" });
  assert.equal(custom.payload.modelProvider, "minimax");
  assert.equal(native.payload.modelProvider, "openai");
});

test("IPC failures degrade to no routing (catch-all)", async () => {
  const runner = makeRunner({ ipcFails: true });
  const result = await runner.send("thread/start", { model: "glm-5.3-flash" });
  assert.equal("modelProvider" in result.payload, false);
});

test("injection templates are syntactically valid JS for any helper name", () => {
  for (const helper of ["ED", "DD", "zzQ9"]) {
    for (const template of [SEND_INJECT_TEMPLATE, PREWARM_INJECT_TEMPLATE]) {
      new vm.Script(`async function f(e,t){ ${template.replaceAll("@IPC@", helper)} }`, {
        filename: `template-${helper}`,
      });
    }
  }
});
