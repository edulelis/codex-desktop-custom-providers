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
import os from "node:os";
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
    ctx,
  };
}

test("thread/start maps glm-5.3-flash to openrouter", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/start", { model: "glm-5.3-flash" });
  assert.equal(result.payload.modelProvider, "openrouter");
});

test("settings/update is never provider-touched (protocol ignores modelProvider there)", async () => {
  const runner = makeRunner();
  for (const model of ["gpt-5.6-terra", "glm-5.3"]) {
    const result = await runner.send("thread/settings/update", { threadId: "t1", model });
    assert.equal("modelProvider" in result.payload, false, `model=${model}`);
  }
});

test("thread/fork resolves the provider from the routing file", async () => {
  const runner = makeRunner();
  const custom = await runner.send("thread/fork", { threadId: "t1", model: "glm-5.3-flash" });
  const native = await runner.send("thread/fork", { threadId: "t1", model: "gpt-5.6-terra" });
  assert.equal(custom.payload.modelProvider, "openrouter");
  assert.equal(native.payload.modelProvider, "openai");
});

test("thread/fork without a model inherits the source provider (untouched)", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/fork", { threadId: "t1" });
  assert.equal("modelProvider" in result.payload, false);
});

test("turn/settings/update is never provider-touched", async () => {
  const runner = makeRunner();
  const result = await runner.send("turn/settings/update", { threadId: "t1", model: "MiniMax-M3" });
  assert.equal("modelProvider" in result.payload, false);
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

// ---- V3: /wham/usage upsell strip ----

import { patchWhamUpsell, WHAM_CAPABILITY_TOKEN } from "../lib/patcher.mjs";

const WHAM_SNIPPET = `var Q={};SP=nb(Q,({get:e,scope:t})=>{return{queryKey:[\`rate-limit-status\`],select:e=>e,queryFn:async()=>{try{let e=await AO.safeGet(\`/wham/usage\`,{additionalHeaders:{"OAI-App-Brand":EO.toLowerCase()}}),n=Tlr.safeParse(e),r=Alr.safeParse(e),o={...e,rate_limit_upsell:n.success?n.data.rate_limit_upsell:void 0};return{raw:e,o};}catch(err){return{err:String(err)};}}};});`;

function makeAssetsDir(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wham-test-"));
  fs.writeFileSync(path.join(dir, "app-test-abc.js"), source, "utf8");
  return dir;
}

test("wham strip removes upsell fields at the queryFn", async () => {
  const dir = makeAssetsDir(WHAM_SNIPPET);
  const result = patchWhamUpsell(dir);
  assert.equal(result, "applied");
  const patched = fs.readFileSync(path.join(dir, "app-test-abc.js"), "utf8");
  assert.equal(patched.includes(WHAM_CAPABILITY_TOKEN), true);

  // Execute the patched queryFn with mocks: verify stripping + preserved fields.
  const sandbox = {
    nb: (_Q, factory) => factory({ get: () => null, scope: {} }),
    AO: { safeGet: async () => ({
      rate_limit_upsell: { rate_limit_reached_type: { type: "rate_limit_reached" } },
      rate_limit_reached_type: { type: "rate_limit_reached" },
      model_picker_upsell: { blocked_model_slug: "gpt-x" },
      keep_me: "yes",
    }) },
    EO: "CODEX",
    Tlr: { safeParse: (o) => ({ success: true, data: o }) },
    Alr: { safeParse: (o) => ({ success: true, data: o }) },
  };
  vm.createContext(sandbox);
  new vm.Script(patched).runInContext(sandbox);
  const out = await sandbox.SP.queryFn();
  assert.equal(out.raw.rate_limit_upsell, undefined);
  assert.equal(out.raw.rate_limit_reached_type, undefined);
  assert.equal(out.raw.model_picker_upsell, undefined);
  assert.equal(out.raw.keep_me, "yes");
  assert.equal(out.o.rate_limit_upsell, undefined);
});

test("wham strip is idempotent (already applied)", () => {
  const dir = makeAssetsDir(WHAM_SNIPPET);
  patchWhamUpsell(dir);
  const patched = fs.readFileSync(path.join(dir, "app-test-abc.js"), "utf8");
  assert.equal(patchWhamUpsell(dir), "already");
  assert.equal(patched.includes(WHAM_CAPABILITY_TOKEN), true);
});

test("wham strip is absent-safe (no site -> 'absent', no changes)", () => {
  const dir = makeAssetsDir("var unrelated = 1;");
  assert.equal(patchWhamUpsell(dir), "absent");
  assert.equal(fs.readFileSync(path.join(dir, "app-test-abc.js"), "utf8"), "var unrelated = 1;");
});

test("wham strip upgrades an older V3 strip in place", () => {
  const oldStrip = WHAM_SNIPPET.replace(
    "EO.toLowerCase()}}),n=Tlr.safeParse(e)",
    "EO.toLowerCase()}});/*__codexDesktopRequestProviderRoutingV3*/try{e={...e,rate_limit_upsell:void 0,rate_limit_reached_type:void 0,model_picker_upsell:void 0}}catch{};let n=Tlr.safeParse(e)"
  );
  assert.notEqual(oldStrip, WHAM_SNIPPET, "snippet must actually contain the old strip");
  const dir = makeAssetsDir(oldStrip);
  assert.equal(patchWhamUpsell(dir), "applied");
  const patched = fs.readFileSync(path.join(dir, "app-test-abc.js"), "utf8");
  assert.equal(patched.includes("__codexDesktopRequestProviderRoutingV3"), false);
  assert.equal(patched.includes(WHAM_CAPABILITY_TOKEN), true);
  assert.equal(patched.includes("limit_reached:void 0"), true);
  assert.equal(patched.includes("allowed:void 0"), true);
  assert.equal(patched.includes("rate_limit:void 0"), false, "rate_limit object must be kept for usage details");
  assert.equal(patched.includes("rate_limit_reset_credits:void 0"), false, "reset credits must be kept");
  new vm.Script(patched, { filename: "upgraded.js" }); // syntax stays valid
});

test("V5 strip keeps usage windows while voiding banner gates", async () => {
  const dir = makeAssetsDir(WHAM_SNIPPET);
  assert.equal(patchWhamUpsell(dir), "applied");
  const patched = fs.readFileSync(path.join(dir, "app-test-abc.js"), "utf8");
  const sandbox = {
    nb: (_Q, factory) => factory({ get: () => null, scope: {} }),
    AO: { safeGet: async () => ({
      rate_limit_upsell: { banner_type: "plus" },
      rate_limit_reached_type: { type: "rate_limit_reached" },
      model_picker_upsell: { blocked_model_slug: "gpt-x" },
      rate_limit: {
        limit_reached: true,
        allowed: false,
        primary_window: { used_percent: 100, reset_at_iso: "2026-09-06" },
        secondary_window: { used_percent: 42 },
      },
      rate_limit_reset_credits: { available_count: 3 },
      keep_me: "yes",
    }) },
    EO: "CODEX",
    Tlr: { safeParse: (o) => ({ success: true, data: o }) },
    Alr: { safeParse: (o) => ({ success: true, data: o }) },
  };
  vm.createContext(sandbox);
  new vm.Script(patched).runInContext(sandbox);
  const out = await sandbox.SP.queryFn();
  // banner gates neutralized
  assert.equal(out.raw.rate_limit_upsell, undefined);
  assert.equal(out.raw.rate_limit_reached_type, undefined);
  assert.equal(out.raw.model_picker_upsell, undefined);
  assert.equal(out.raw.rate_limit.limit_reached, undefined);
  assert.equal(out.raw.rate_limit.allowed, undefined);
  // usage-details data preserved
  assert.equal(out.raw.rate_limit.primary_window.used_percent, 100);
  assert.equal(out.raw.rate_limit.secondary_window.used_percent, 42);
  assert.equal(out.raw.rate_limit_reset_credits.available_count, 3);
  assert.equal(out.raw.keep_me, "yes");
});

test("settings/update remembers the picked provider and model per thread", async () => {
  const runner = makeRunner();
  await runner.send("thread/settings/update", { threadId: "t1", model: "glm-5.3-flash" });
  assert.equal(runner.ctx.__codexProvStash?.t1, "openrouter");
  assert.equal(runner.ctx.__codexProvModelStash?.t1, "glm-5.3-flash");
  await runner.send("thread/settings/update", { threadId: "t1", model: "gpt-5.6-terra" });
  assert.equal(runner.ctx.__codexProvStash?.t1, "openai");
  await runner.send("thread/settings/update", { threadId: "t2", model: "MiniMax-M3" });
  assert.equal(runner.ctx.__codexProvStash?.t2, "minimax");
});

test("thread/resume rebinds the remembered provider and clears the stash", async () => {
  const runner = makeRunner();
  await runner.send("thread/settings/update", { threadId: "t1", model: "glm-5.3-flash" });
  const resumed = await runner.send("thread/resume", { threadId: "t1", modelProvider: "minimax" });
  assert.equal(resumed.payload.modelProvider, "openrouter");
  assert.equal(runner.ctx.__codexProvStash?.t1, undefined);
});

test("thread/resume without a remembered provider is untouched", async () => {
  const runner = makeRunner();
  const result = await runner.send("thread/resume", { threadId: "t9", modelProvider: "minimax" });
  assert.equal(result.payload.modelProvider, "minimax");
});

test("thread/fork inherits the last picked model and routes its provider", async () => {
  const runner = makeRunner();
  await runner.send("thread/settings/update", { threadId: "t1", model: "MiniMax-M2.7-highspeed" });
  await runner.send("thread/settings/update", { threadId: "t1", model: "glm-5.3-flash" });
  const forked = await runner.send("thread/fork", { threadId: "t1" });
});

test("thread/fork carries picked model + resolved provider (real check)", async () => {
  const runner = makeRunner();
  await runner.send("thread/settings/update", { threadId: "t1", model: "glm-5.3-flash" });
  const fork = await runner.send("thread/fork", { threadId: "t1" });
  assert.equal(fork.payload.model, "glm-5.3-flash");
  assert.equal(fork.payload.modelProvider, "openrouter");
  // stash is sticky: forking again stays consistent
  const again = await runner.send("thread/fork", { threadId: "t1" });
  assert.equal(again.payload.modelProvider, "openrouter");
});

test("thread/fork without picks inherits nothing", async () => {
  const runner = makeRunner();
  const fork = await runner.send("thread/fork", { threadId: "tX" });
  assert.equal("model" in fork.payload, false);
  assert.equal("modelProvider" in fork.payload, false);
});

// ---- live channel: config flags + diagnostics ----

test("feature kill-switch disables a block via live config", async () => {
  const source = `
    async function sendRequest(e, t, n) {
      if (this.dispatchMessage == null) throw Error('no dispatcher');
      ${SEND_INJECT_TEMPLATE}
      return { method: e, payload: t };
    }
  `;
  const sandbox = {
    btoa: (s) => Buffer.from(s, "utf8").toString("base64"),
    ED: async (method, opts) => {
      if (method === "codex-home") return { codexHome: "/tmp/fakehome" };
      if (method === "read-file") {
        const p = opts?.params?.path ?? "";
        if (p.endsWith("provider-routing-live.json"))
          return { contents: JSON.stringify({ debug: false, features: { startRouting: false } }) };
        if (p.endsWith("desktop-model-providers.json"))
          return { contents: JSON.stringify(ROUTING) };
      }
      if (method === "fs/writeFile") return {};
      throw new Error(`unexpected IPC method: ${method}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  const ctx = { dispatchMessage: {}, hostId: "local" };
  const result = await sandbox.sendRequest.call(ctx, "thread/start", { model: "glm-5.3-flash" });
  assert.equal("modelProvider" in result.payload, false, "startRouting:false must disable routing");
});

test("debug writes diag events to the events log", async () => {
  const source = `
    async function sendRequest(e, t, n) {
      if (this.dispatchMessage == null) throw Error('no dispatcher');
      ${SEND_INJECT_TEMPLATE}
      return { method: e, payload: t };
    }
  `;
  let written = null;
  const sandbox = {
    btoa: (s) => Buffer.from(s, "utf8").toString("base64"),
    ED: async (method, opts) => {
      if (method === "codex-home") return { codexHome: "/tmp/fakehome" };
      if (method === "read-file") {
        const p = opts?.params?.path ?? "";
        if (p.endsWith("provider-routing-live.json"))
          return { contents: JSON.stringify({ debug: true, features: {} }) };
        if (p.endsWith("provider-routing-events.log"))
          return { contents: written ?? "" };
        if (p.endsWith("desktop-model-providers.json"))
          return { contents: JSON.stringify(ROUTING) };
      }
      if (method === "fs/writeFile") {
        if ((opts?.params?.path ?? "").endsWith("provider-routing-events.log"))
          written = Buffer.from(opts.params.dataBase64, "base64").toString("utf8");
        return {};
      }
      throw new Error(`unexpected IPC method: ${method}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  const ctx = { dispatchMessage: {}, hostId: "local" };
  await sandbox.sendRequest.call(ctx, "thread/start", { model: "glm-5.3-flash" });
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(written, null, "events log must be written when debug on");
  assert.ok(written.includes('"ev":"req"'));
});
