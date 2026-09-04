#!/usr/bin/env node
// CLI entry point for the provider-routing patcher. Library: ./lib/patcher.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PatchError,
  patchApp,
  stopTargetAppProcesses,
} from "./lib/patcher.mjs";

function die(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function invokingUserHome() {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== "root") {
    const { stdout } = spawnSync("/usr/bin/dscl", [
      ".", "-read", `/Users/${sudoUser}`, "NFSHomeDirectory",
    ], { encoding: "utf8" });
    const match = stdout?.match(/NFSHomeDirectory:\s*(\S+)/);
    if (match) return match[1];
  }
  return os.homedir();
}

function expandHome(value) {
  return path.resolve(value.replace(/^~(?=\/|$)/, invokingUserHome()));
}

function parseArgs(argv) {
  const home = invokingUserHome();
  const codexHome = process.env.CODEX_HOME
    ? expandHome(process.env.CODEX_HOME)
    : path.join(home, ".codex");
  const args = {
    app: "/Applications/ChatGPT.app",
    config: path.join(codexHome, "desktop-model-providers.json"),
    backupDir: path.join(home, "Applications", "ChatGPT Patch Backups"),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") args.app = expandHome(argv[++i]);
    else if (arg === "--config") args.config = expandHome(argv[++i]);
    else if (arg === "--backup-dir") args.backupDir = expandHome(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "USAGE: node patch_chatgpt_provider_routing.mjs [--app APP] [--config CONFIG] " +
        "[--backup-dir DIR] [--dry-run]\n" +
        "\nInstall automatic custom-provider routing for the ChatGPT/Codex desktop app." +
        "\n--dry-run verifies configuration and build compatibility without modifying the app."
      );
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
try {
  if (!args.dryRun) {
    stopTargetAppProcesses(args.app);
  }
  const backup = await patchApp(args.app, args.config, args.backupDir, args.dryRun);
  if (args.dryRun) {
    console.log("\nNo files were changed.");
  } else {
    console.log("\nSUCCESS");
    console.log(`New threads (and mid-thread model swaps) now resolve modelProvider from: ${args.config}`);
    console.log("Exact mappings use model_providers; unmapped models use default_provider.");
    if (backup) console.log(`Backup: ${backup}`);
    console.log(
      "A future app update may replace this patch; this installer will refuse " +
        "to patch a changed request-layer layout."
    );
  }
} catch (error) {
  if (error instanceof PatchError) {
    die(error.message);
  } else if (error?.code === "EACCES" || error?.code === "EPERM") {
    die(
      `Permission denied: ${error.message}\n` +
        "Modifying /Applications/ChatGPT.app requires elevated permissions; " +
        "run with sudo or via patch-codex-app.sh (native admin dialog)."
    );
  } else {
    die(error?.stack ?? String(error));
  }
}
