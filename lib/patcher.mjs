// Library for the ChatGPT/Codex desktop app provider-routing patcher.
// Extracted so the CLI entry point and the test suite can share it.
// See patch_chatgpt_provider_routing.mjs (CLI) and test/injection.test.mjs.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const bplistParser = require("bplist-parser");
const bplistCreator = require("bplist-creator");
const plistLib = require("plist");

const ASAR_PACKAGE = "@electron/asar";
// Build-agnostic request-layer provider routing for the ChatGPT/Codex macOS app.
//
// Node port of patch_chatgpt_provider_routing.py (same behavior, same regexes,
// same fail-closed rules). Leaves the native model picker untouched and routes
// providers at request time using ~/.codex/desktop-model-providers.json:
//
//   - thread/start + prewarmThreadStart: new threads resolve modelProvider.
//   - thread/settings/update + turn/settings/update (V2): changing the model in
//     an existing thread swaps the provider from the next turn (custom slugs
//     use their mapping; native slugs fall back to default_provider).
//
// The per-build minified identifiers (IPC helper, timeout constant, prewarm
// helper) are captured structurally at patch time — no hardcoded names.
// Fail-closed: every structure must match exactly once before the app is
// modified. Older marker-patched installs are upgraded in place (V1 -> V2).
//
// Requires: macOS, Node >= 18, `npm install` in this repository.
// Elevation: run as root (sudo or the patch-codex-app.sh wrapper) — the app
// bundle is protected by macOS App Management even when user-owned.



export const MARKER_TEXT = "__codexDesktopRequestProviderRouting";
export const INJECTION_VERSION = "V2";
export const CAPABILITY_TOKEN = MARKER_TEXT + INJECTION_VERSION;
// V3: strip the ChatGPT-backend usage upsell fields at the /wham/usage
// queryFn so the "You're out of Codex and Work usage" banner never gets
// data. Separate injection site + token; applied best-effort.
export const WHAM_CAPABILITY_TOKEN = MARKER_TEXT + "V3";
export const WHAM_RE = new RegExp(
  "let (\\w+)=await (\\w+)\\.safeGet\\(`(/wham/usage)`,\\{additionalHeaders:\\{\"OAI-App-Brand\":(\\w+)\\.toLowerCase\\(\\)\\}\\}\\),"
, "g");
export const ROUTING_FILENAME = "desktop-model-providers.json";
export const DISPATCHER_GUARD =
  "if(this.dispatchMessage==null)throw Error(" +
  "`AppServerRequestClient is missing a message dispatcher`);";

export class PatchError extends Error {}

// ---------------------------------------------------------------------------
// Structural matchers. Group 1 captures the per-build minified name so the
// injection can be generated for whatever the current build uses.
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SEND_RE = new RegExp(
  "async sendRequest\\(e,t,n\\)\\{" + escapeRegExp(DISPATCHER_GUARD) +
  "return e===`config/read`\\?this\\.sendConfigReadRequest\\(t,n\\):" +
  "this\\.enqueueRequest\\(e,t,e===`plugin/list`&&n\\?\\.timeoutMs==null\\?" +
  "\\{\\.\\.\\.n,timeoutMs:(\\w+)\\}:n\\)\\}"
, "g");
export const PREWARM_RE = new RegExp(
  "async prewarmThreadStart\\(e,t\\)\\{" + escapeRegExp(DISPATCHER_GUARD) +
  "let n=t\\?\\.priority\\?\\?`critical`,r=(\\w+)\\(`thread/start`,t\\?\\.source\\)"
, "g");
export const IPC_RE = /(\w+)\(`read-file`,\{params:\{hostId:/g;

// JS source template. "@IPC@" is substituted with the captured IPC helper.
// The "\\\\" sequences produce `\\` in the emitted JS (template-literal
// backslash escapes), matching the reference Python implementation 1:1.
export const SEND_INJECT_TEMPLATE =
  "/*" + CAPABILITY_TOKEN + "*/" +
  "e===`thread/list`&&(t==null||typeof t!==`object`?t={modelProviders:[]}:" +
  "t.modelProviders==null&&(t={...t,modelProviders:[]}));" +
  "if(e===`thread/start`&&t!=null&&typeof t===`object`&&t.modelProvider==null)try{" +
  "let{codexHome:r}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}})," +
  "i=r.includes(`\\\\`)&&!r.includes(`/`)?`\\\\`:`/`," +
  "a=`${r.replace(/[\\\\/]+$/u,``)}${i}" + ROUTING_FILENAME + "`," +
  "{contents:o}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:a}})," +
  "s=JSON.parse(o),c=s?.model_providers?.[t.model]??s?.default_provider;" +
  "typeof c===`string`&&c.length>0&&(t={...t,modelProvider:c})" +
  "}catch{}" +
  "if((e===`thread/settings/update`||e===`turn/settings/update`)" +
  "&&t!=null&&typeof t===`object`&&t.model!=null&&t.modelProvider==null)try{" +
  "let{codexHome:n}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}})," +
  "d=n.includes(`\\\\`)&&!n.includes(`/`)?`\\\\`:`/`," +
  "u=`${n.replace(/[\\\\/]+$/u,``)}${d}" + ROUTING_FILENAME + "`," +
  "{contents:l}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:u}})," +
  "g=JSON.parse(l),h=g?.model_providers?.[t.model]??g?.default_provider;" +
  "typeof h===`string`&&h.length>0&&(t={...t,modelProvider:h})" +
  "}catch{}";

export const PREWARM_INJECT_TEMPLATE =
  "/*" + MARKER_TEXT + "*/" +
  "if(e!=null&&typeof e===`object`&&e.modelProvider==null)try{" +
  "let{codexHome:n}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}})," +
  "r=n.includes(`\\\\`)&&!n.includes(`/`)?`\\\\`:`/`," +
  "i=`${n.replace(/[\\\\/]+$/u,``)}${r}" + ROUTING_FILENAME + "`," +
  "{contents:a}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:i}})," +
  "o=JSON.parse(a),s=o?.model_providers?.[e.model]??o?.default_provider;" +
  "typeof s===`string`&&s.length>0&&(e={...e,modelProvider:s})" +
  "}catch{}";

export const DEFAULT_PROVIDER_CONFIG = {
  version: 1,
  default_provider: "openai",
  providers: [
    {
      id: "openai",
      label: "ChatGPT / OpenAI",
      description: "Uses your signed-in ChatGPT account",
    },
  ],
  model_providers: {},
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function status(tag, message, detail) {
  const line = `[${tag}] ${message}`;
  console.log(line.padEnd(120));
  if (detail !== undefined) {
    for (const row of String(detail).split("\n")) {
      console.log(`          ↳ ${row}`);
    }
  }
}

function run(command, args, label) {
  if (label) status("STEP", label, [command, ...args].join(" "));
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: label ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new PatchError(
      `Command failed (${result.status}): ${command} ${args.join(" ")}` +
        (output ? `\n${output}` : "")
    );
  }
  return result;
}

function invokingUserHome() {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== "root") {
    const { homedir } = spawnSync("/usr/bin/dscl", [
      ".", "-read", `/Users/${sudoUser}`, "NFSHomeDirectory",
    ], { encoding: "utf8" });
    const match = homedir?.match(/NFSHomeDirectory:\s*(\S+)/);
    if (match) return match[1];
  }
  return os.homedir();
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new PatchError("This installer only supports macOS");
  }
}

// ---------------------------------------------------------------------------
// ASAR + plist handling
// ---------------------------------------------------------------------------

export function asarHeaderHash(asarPath) {
  const handle = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(handle, sizeBuf, 0, 8, 0) !== 8) {
      throw new PatchError("ASAR archive is too short to contain a header");
    }
    const sizePayload = sizeBuf.readUInt32LE(0);
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    if (sizePayload !== 4 || headerPickleSize < 8) {
      throw new PatchError("ASAR archive has an invalid header-size pickle");
    }
    const headerPickle = Buffer.alloc(headerPickleSize);
    if (fs.readSync(handle, headerPickle, 0, headerPickleSize, 8) !== headerPickleSize) {
      throw new PatchError("ASAR archive contains a truncated header");
    }
    const headerPayloadSize = headerPickle.readUInt32LE(0);
    const headerStringSize = headerPickle.readUInt32LE(4);
    if (headerPayloadSize > headerPickleSize - 4) {
      throw new PatchError("ASAR header payload size is invalid");
    }
    const headerStart = 8;
    const headerEnd = headerStart + headerStringSize;
    if (headerEnd > headerPickle.length) {
      throw new PatchError("ASAR header string is truncated");
    }
    const headerJson = headerPickle.subarray(headerStart, headerEnd);
    try {
      JSON.parse(headerJson.toString("utf8"));
    } catch {
      throw new PatchError("ASAR header does not contain valid UTF-8 JSON");
    }
    return crypto.createHash("sha256").update(headerJson).digest("hex");
  } finally {
    fs.closeSync(handle);
  }
}

export function asarIntegrityHash(info) {
  const value = info?.ElectronAsarIntegrity?.["Resources/app.asar"]?.hash;
  if (typeof value !== "string") {
    throw new PatchError("Info.plist has no Electron ASAR integrity entry");
  }
  return value.toLowerCase();
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function loadPlist(plistPath) {
  const raw = fs.readFileSync(plistPath);
  const binary = raw.subarray(0, 8).toString("latin1") === "bplist00";
  let info;
  try {
    info = binary ? bplistParser.parseBuffer(raw)[0] : plistLib.parse(raw.toString("utf8"));
  } catch (error) {
    throw new PatchError(`Cannot parse ${plistPath}: ${error.message}`);
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new PatchError(`Unexpected plist root in ${plistPath}`);
  }
  return { info, format: binary ? "binary" : "xml" };
}

export function savePlist(plistPath, info, format) {
  let raw;
  if (format === "binary") {
    raw = bplistCreator(info);
  } else {
    raw = Buffer.from(plistLib.build(info), "utf8");
  }
  // Round-trip safety: re-parse what we are about to write and compare.
  let reparsed;
  try {
    reparsed =
      format === "binary"
        ? bplistParser.parseBuffer(raw)[0]
        : plistLib.parse(raw.toString("utf8"));
  } catch (error) {
    throw new PatchError(`Serialised plist does not re-parse: ${error.message}`);
  }
  if (!deepEqual(info, reparsed)) {
    throw new PatchError(
      "Plist round-trip mismatch; refusing to write a lossy Info.plist"
    );
  }
  return raw;
}

export function containsMarker(asarPath, marker) {
  const handle = fs.openSync(asarPath, "r");
  try {
    const chunkSize = 4 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize + marker.length);
    let position = 0;
    let carry = 0;
    while (true) {
      const read = fs.readSync(handle, buffer, carry, chunkSize, position);
      if (read === 0) return false;
      const view = buffer.subarray(0, carry + read);
      if (view.includes(marker)) return true;
      // Keep the tail so markers spanning chunk boundaries are still found.
      buffer.copy(buffer, 0, view.length - marker.length + 1);
      carry = marker.length - 1;
      position += read;
    }
  } finally {
    fs.closeSync(handle);
  }
}

// ---------------------------------------------------------------------------
// App process management
// ---------------------------------------------------------------------------

export function findTargetAppProcesses(app) {
  const result = spawnSync("/usr/bin/pgrep", ["-f", `${app}/Contents/MacOS/`], {
    encoding: "utf8",
  });
  const pids = (result.stdout ?? "")
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return pids;
}

function waitUntilAllGone(pids, deadline) {
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    });
    if (alive.length === 0) return [];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  });
}

export function stopTargetAppProcesses(app, { allowRunning = false } = {}) {
  const executable = path.join(app, "Contents", "MacOS", "ChatGPT");
  if (!fs.existsSync(executable)) {
    throw new PatchError(`Cannot identify the target app executable: ${executable}`);
  }
  const pids = findTargetAppProcesses(app);
  if (pids.length === 0) {
    status("PROCESS", "The target ChatGPT app is not running.", app);
    return;
  }
  if (allowRunning) {
    status("WARNING", "Target-app processes are running, but closing was disabled.",
      `PIDs: ${pids.join(", ")}`);
    return;
  }
  status("CLOSE", `Closing ${pids.length} process(es) launched from the target app bundle.`,
    `PIDs: ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const remaining = waitUntilAllGone(pids, Date.now() + 5000);
  if (remaining.length > 0) {
    status("KILL", `Force-killing ${remaining.length} remaining process(es).`,
      `PIDs: ${remaining.join(", ")}`);
    for (const pid of remaining) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    const stillThere = waitUntilAllGone(pids, Date.now() + 3000);
    if (stillThere.length > 0) {
      throw new PatchError(
        `Could not stop target-app processes: ${stillThere.join(", ")}`
      );
    }
  }
  status("CLOSED", "All processes belonging to the target app bundle have stopped.");
}

// ---------------------------------------------------------------------------
// Backup / restore / atomic file replacement
// ---------------------------------------------------------------------------

function timestampName(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) + pad(now.getDate()) +
    "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  );
}

export function makeBackup(app, backupDir, version, build) {
  fs.mkdirSync(backupDir, { recursive: true });
  const safe = (value) => value.replace(/[^A-Za-z0-9._-]+/g, "-");
  const base = `ChatGPT-${safe(version)}-build-${safe(build)}-${timestampName()}`;
  let backup = path.join(backupDir, `${base}.app`);
  let suffix = 1;
  while (fs.existsSync(backup)) {
    backup = path.join(backupDir, `${base}-${suffix}.app`);
    suffix += 1;
  }
  run("/usr/bin/ditto", [app, backup], "Creating a complete app backup");
  if (!fs.existsSync(path.join(backup, "Contents", "Resources", "app.asar"))) {
    throw new PatchError(`Backup verification failed: ${backup}`);
  }
  return backup;
}

export function restoreBackup(app, backup) {
  const stamp = timestampName();
  let failedCopy = app + `.patch-failed-${stamp}`;
  let suffix = 1;
  while (fs.existsSync(failedCopy)) {
    failedCopy = `${app}.patch-failed-${stamp}-${suffix}`;
    suffix += 1;
  }
  fs.renameSync(app, failedCopy);
  try {
    run("/usr/bin/ditto", [backup, app], "Restoring the original app from backup");
  } catch (error) {
    throw new PatchError(
      `Restore failed; the previous app bundle remains at: ${failedCopy}\n${error.message}`
    );
  }
  return failedCopy;
}

export function atomicReplaceFile(source, target) {
  const originalStat = fs.statSync(target);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.patch-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  );
  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, originalStat.mode & 0o7777);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      fs.chownSync(temporary, originalStat.uid, originalStat.gid);
    }
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// ---------------------------------------------------------------------------
// Provider routing configuration
// ---------------------------------------------------------------------------

export function ensureProviderConfig(configPath, { overwrite = false } = {}) {
  if (overwrite || !fs.existsSync(configPath) || fs.statSync(configPath).size === 0) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_PROVIDER_CONFIG, null, 2) + "\n");
    status("CONFIG", "Provider-routing config created.", configPath);
    return;
  }
  try {
    JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new PatchError(`Cannot read valid JSON from ${configPath}: ${error.message}`);
  }
}

export function validateNoGlobalProvider(configPath) {
  const codexConfig = path.join(path.dirname(configPath), "config.toml");
  if (!fs.existsSync(codexConfig)) {
    throw new PatchError(`Missing Codex config: ${codexConfig}`);
  }
  let inTopLevel = true;
  for (const rawLine of fs.readFileSync(codexConfig, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inTopLevel = false;
      continue;
    }
    if (inTopLevel && /^model_provider\s*=/.test(line)) {
      throw new PatchError(
        "Remove the top-level `model_provider = ...` line from config.toml; " +
          "this patch selects the provider per new thread."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle matching / patching / upgrading
// ---------------------------------------------------------------------------

export function resolveIpcHelper(source) {
  const names = new Set();
  for (const match of source.matchAll(IPC_RE)) names.add(match[1]);
  if (names.size !== 1) {
    throw new PatchError(
      `Expected exactly one \`read-file\` IPC helper name, found ${JSON.stringify([...names].sort())}.`
    );
  }
  const helper = names.values().next().value;
  const codexHomeHits = [...source.matchAll(new RegExp(escapeRegExp(helper) + "\\(`codex-home`", "g"))];
  if (codexHomeHits.length < 1) {
    throw new PatchError(`Captured IPC helper '${helper}' is never used with \`codex-home\`.`);
  }
  return helper;
}

function* walkAssets(assets) {
  for (const entry of fs.readdirSync(assets, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      yield path.join(assets, entry.name);
    }
  }
}

export function findRequestBundle(assets) {
  const matches = [];
  for (const filePath of walkAssets(assets)) {
    let source;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const sendHits = [...source.matchAll(SEND_RE)];
    const prewarmHits = [...source.matchAll(PREWARM_RE)];
    if (sendHits.length > 0 || prewarmHits.length > 0) {
      if (sendHits.length !== 1 || prewarmHits.length !== 1) {
        throw new PatchError(
          `${path.basename(filePath)} matches the request layer ambiguously ` +
            `(sendRequest=${sendHits.length}, prewarmThreadStart=${prewarmHits.length})`
        );
      }
      matches.push({ filePath, source });
    }
  }
  if (matches.length !== 1) {
    throw new PatchError(
      `Expected exactly one request bundle, found ${matches.length}. ` +
        "The app build is unsupported, updated, or already modified."
    );
  }
  return matches[0];
}

export function findPatchedBundle(assets) {
  for (const filePath of walkAssets(assets)) {
    try {
      if (fs.readFileSync(filePath, "utf8").includes(MARKER_TEXT)) return filePath;
    } catch {
      continue;
    }
  }
  return null;
}

export function patchRequestBundle(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const ipcHelper = resolveIpcHelper(source);

  const sendInjection = SEND_INJECT_TEMPLATE.replaceAll("@IPC@", ipcHelper);
  const prewarmInjection = PREWARM_INJECT_TEMPLATE.replaceAll("@IPC@", ipcHelper);

  const sendPrefix = "async sendRequest(e,t,n){" + DISPATCHER_GUARD;
  const prewarmPrefix = "async prewarmThreadStart(e,t){" + DISPATCHER_GUARD;

  let patched;
  let sendCount = 0;
  let prewarmCount = 0;

  patched = source.replace(SEND_RE, (match) => {
    sendCount += 1;
    return sendCount === 1 ? sendPrefix + sendInjection + match.slice(sendPrefix.length) : match;
  });
  patched = patched.replace(PREWARM_RE, (match) => {
    prewarmCount += 1;
    return prewarmCount === 1 ? prewarmPrefix + prewarmInjection + match.slice(prewarmPrefix.length) : match;
  });

  if (sendCount !== 1 || prewarmCount !== 1) {
    throw new PatchError(
      `${path.basename(filePath)} does not match the request layer ` +
        `(sendRequest=${sendCount}, prewarmThreadStart=${prewarmCount})`
    );
  }
  if (countOccurrences(patched, ROUTING_FILENAME) !== 3) {
    throw new PatchError("Provider-routing injection validation failed");
  }
  if (countOccurrences(patched, MARKER_TEXT) !== 2) {
    throw new PatchError("Provider-routing marker validation failed");
  }
  fs.writeFileSync(filePath, patched, "utf8");
}

export function upgradeRequestBundle(filePath) {
  let source = fs.readFileSync(filePath, "utf8");
  if (source.includes(WHAM_CAPABILITY_TOKEN)) {
    throw new PatchError(`${path.basename(filePath)} already contains the V3 injection.`);
  }
  if (!source.includes(CAPABILITY_TOKEN)) {
  // V1 (or older): rewrite the sendRequest region to the current template.
  const ipcHelper = resolveIpcHelper(source);
  const newInjection = SEND_INJECT_TEMPLATE.replaceAll("@IPC@", ipcHelper);
  const regionRe = new RegExp(escapeRegExp("/*" + MARKER_TEXT) + "\\w*\\*/.*?\\}catch\\{\\}", "s");
  let patched;
  let regions = 0;
  patched = source.replace(regionRe, (match) => {
    regions += 1;
    return regions === 1 ? newInjection : match;
  });
  if (regions !== 1) {
    throw new PatchError(
      `${path.basename(filePath)} marker injection region did not match exactly once.`
    );
  }
  if (countOccurrences(patched, ROUTING_FILENAME) !== 3) {
    throw new PatchError("Provider-routing upgrade validation failed");
  }
  source = patched;
  }
  // A V2 send region is already current; the V3 wham strip is applied separately.
  if (countOccurrences(source, ROUTING_FILENAME) !== 3) {
    throw new PatchError("Provider-routing upgrade validation failed");
  }
  if (countOccurrences(source, MARKER_TEXT) !== 2) {
    throw new PatchError("Provider-routing upgrade marker validation failed");
  }
  fs.writeFileSync(filePath, source, "utf8");
}

export function patchWhamUpsell(assets) {
  // Best-effort V3 strip. Returns "applied" | "already" | "absent".
  const target = findWhamUpsellSite(assets);
  if (target === null) return "absent";
  if (target.already) return "already";
  const { filePath } = target;
  let patched;
  let count = 0;
  const source = fs.readFileSync(filePath, "utf8");
  const markersBefore = countOccurrences(source, MARKER_TEXT);
  patched = source.replace(WHAM_RE, (match, resp, client, url, brand) => {
    count += 1;
    if (count !== 1) return match;
    return (
      `let ${resp}=await ${client}.safeGet(\`${url}\`,{additionalHeaders:{"OAI-App-Brand":${brand}.toLowerCase()}});` +
      `/*${WHAM_CAPABILITY_TOKEN}*/` +
      `try{${resp}={...${resp},rate_limit_upsell:void 0,rate_limit_reached_type:void 0,model_picker_upsell:void 0}}catch{};` +
      "let "
    );
  });
  if (count !== 1) {
    throw new PatchError(`${path.basename(filePath)} wham upsell site did not match exactly once.`);
  }
  if (countOccurrences(patched, MARKER_TEXT) !== markersBefore + 1) {
    throw new PatchError("Wham upsell strip validation failed");
  }
  fs.writeFileSync(filePath, patched, "utf8");
  return "applied";
}

function findWhamUpsellSite(assets) {
  let found = null;
  for (const filePath of walkAssets(assets)) {
    let source;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("`/wham/usage`")) continue;
    const already = source.includes(WHAM_CAPABILITY_TOKEN);
    const matches = [...source.matchAll(WHAM_RE)];
    if (already) {
      return { filePath, already: true, matches: matches.length };
    }
    if (matches.length === 1) {
      if (found !== null) {
        throw new PatchError("Wham upsell site matches more than one bundle.");
      }
      found = { filePath, already: false, matches: matches.length };
    } else if (matches.length > 1) {
      throw new PatchError(
        `${path.basename(filePath)} matches the /wham/usage queryFn ambiguously (${matches.length}).`
      );
    }
  }
  return found;
}

export function reportWham(result) {
  if (result === "applied") status("OK", "Usage upsell banner suppression (V3) applied.");
  else if (result === "already") status("OK", "Usage upsell banner suppression already present.");
  else status("WARN", "No /wham/usage queryFn site matched; banner suppression skipped (routing unaffected).");
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function syntaxCheckBundle(filePath) {
  // The bundle is ESM, so parse it with node's own parser (detect-module aware).
  // process.execPath keeps working regardless of how PATH is set (e.g. under sudo).
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new PatchError(
      `Patched bundle failed a syntax check:${output ? `\n${output}` : ""}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main patch flow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main patch flow
// ---------------------------------------------------------------------------

export async function patchApp(app, providerConfig, backupDir, dryRun) {
  assertMacOS();

  const infoPath = path.join(app, "Contents", "Info.plist");
  const asarPath = path.join(app, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(app) || !fs.existsSync(infoPath) || !fs.existsSync(asarPath)) {
    throw new PatchError(`Not a supported ChatGPT app bundle: ${app}`);
  }

  ensureProviderConfig(providerConfig);
  validateNoGlobalProvider(providerConfig);

  const { info, format } = loadPlist(infoPath);
  const version = String(info.CFBundleShortVersionString ?? "unknown");
  const build = String(info.CFBundleVersion ?? "unknown");
  status("APP", `ChatGPT/Codex ${version} (build ${build})`);

  const currentHash = asarHeaderHash(asarPath);
  const expectedHash = asarIntegrityHash(info);
  if (currentHash !== expectedHash) {
    throw new PatchError(
      "The ASAR header does not match Info.plist integrity metadata. " +
        "Restore or reinstall the official app before applying this patch."
    );
  }
  status("OK", "Original ASAR integrity verified.");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-routing-"));
  let backup = null;
  try {
    const extracted = path.join(temporary, "app");
    const patchedAsar = path.join(temporary, "app.asar");

    status("STEP", "Extracting application resources",
      `npx ${ASAR_PACKAGE} extract ${asarPath} -> ${extracted}`);
    await asar.extractAll(asarPath, extracted);

    const assets = path.join(extracted, "webview", "assets");
    if (!fs.existsSync(assets)) {
      throw new PatchError("Extracted app has no webview/assets directory");
    }

    const patchedBundle = findPatchedBundle(assets);
    if (patchedBundle !== null) {
      const previous = fs.readFileSync(patchedBundle, "utf8");
      if (previous.includes(CAPABILITY_TOKEN) && previous.includes(WHAM_CAPABILITY_TOKEN)) {
        status("OK",
          "Request-layer provider routing (mid-thread swaps + usage-banner suppression) is already installed.");
        return null;
      }
      status("OK", `Found existing provider-routing patch: ${path.basename(patchedBundle)} — upgrading in place.`);
      if (dryRun) {
        status("OK", "Dry run passed. This app can be upgraded in place.");
        return null;
      }
      upgradeRequestBundle(patchedBundle);
      syntaxCheckBundle(patchedBundle);
      reportWham(patchWhamUpsell(assets));
    } else {
      const { filePath } = findRequestBundle(assets);
      const ipcHelper = resolveIpcHelper(fs.readFileSync(filePath, "utf8"));
      status("OK", `Matched request bundle: ${path.basename(filePath)}`);
      status("OK", `Captured per-build identifiers: ipc=${ipcHelper}`);
      if (dryRun) {
        status("OK", "Dry run passed. This app is compatible with the fallback patch.");
        return null;
      }
      patchRequestBundle(filePath);
      syntaxCheckBundle(filePath);
      reportWham(patchWhamUpsell(assets));
    }

    status("STEP", "Packing patched application resources",
      `npx ${ASAR_PACKAGE} pack ${extracted} -> ${patchedAsar}`);
    await asar.createPackage(extracted, patchedAsar);

    if (!containsMarker(patchedAsar, Buffer.from(MARKER_TEXT, "utf8"))) {
      throw new PatchError("Packed ASAR is missing the provider-routing marker");
    }

    const patchedHeaderHash = asarHeaderHash(patchedAsar);
    info.ElectronAsarIntegrity["Resources/app.asar"].hash = patchedHeaderHash;
    const plistBytes = savePlist(infoPath, info, format);
    const patchedPlist = path.join(temporary, "Info.plist");
    fs.writeFileSync(patchedPlist, plistBytes);

    backup = makeBackup(app, backupDir, version, build);

    let mutationStarted = false;
    try {
      mutationStarted = true;
      atomicReplaceFile(patchedAsar, asarPath);
      atomicReplaceFile(patchedPlist, infoPath);
      run("/usr/bin/codesign", ["--deep", "--force", "--sign", "-", app],
        "Applying an ad-hoc app signature");
      run("/usr/bin/codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", app],
        "Verifying the app signature");
      const finalInfo = loadPlist(infoPath).info;
      if (asarHeaderHash(asarPath) !== asarIntegrityHash(finalInfo)) {
        throw new PatchError("Installed ASAR integrity verification failed");
      }
      if (!containsMarker(asarPath, Buffer.from(MARKER_TEXT, "utf8"))) {
        throw new PatchError("Installed ASAR is missing the provider-routing marker");
      }
    } catch (error) {
      if (mutationStarted) {
        console.error("[RECOVERY] Patch failed after app mutation; restoring backup.");
        try {
          const failedCopy = restoreBackup(app, backup);
          console.error(`[RECOVERY] Original app restored. Failed patched copy: ${failedCopy}`);
        } catch (restoreError) {
          console.error(`[RECOVERY ERROR] Automatic restore failed: ${restoreError.message}`);
          console.error(`[RECOVERY ERROR] Full backup remains at: ${backup}`);
        }
      }
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  return backup;
}
