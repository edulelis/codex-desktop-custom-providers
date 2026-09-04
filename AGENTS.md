# AGENTS.md — guidance for AI agents and contributors

Unofficial patch for the macOS ChatGPT/Codex desktop app that adds
request-layer custom-provider routing (OpenRouter, DeepSeek, MiniMax, ...)
while keeping the signed-in ChatGPT account for native models. This is a
fork of Keksuccino/Better-Codex-App-Custom-Provider-Support; the installer
is a pure-Node port (no Python) and is build-agnostic.

## Repository layout

- `lib/patcher.mjs` — the library: structural matchers (`SEND_RE`,
  `PREWARM_RE`, `IPC_RE`), injection templates (`SEND_INJECT_TEMPLATE`,
  `PREWARM_INJECT_TEMPLATE`), ASAR hash/plist/backup/codesign helpers, and
  the `patchApp` flow. Everything of substance lives here.
- `patch_chatgpt_provider_routing.mjs` — thin CLI entry point.
- `patch-codex-app.sh` — one-off wrapper: native macOS admin-password dialog,
  detaches when run from inside the app itself (kill → elevated patch →
  reopen), refreshes the fork and `node_modules` first. `--check` = dry run.
- `test/injection.test.mjs` — `node:test` behavioral tests: the real
  injection templates run in a `vm` sandbox with a stubbed IPC helper.
- `SETUP.md` — complete configuration guide (providers, routing JSON, model
  catalog merging/sorting, env-based key injection, troubleshooting).

## Commands

```bash
npm install            # once
npm test               # behavioral + unit tests — no elevation needed
npm run patch:dry      # dry-run against the installed app — no elevation
npm run patch          # real patch — REQUIRES root (see elevation below)
```

Day-to-day work (editing mappings, catalog, config.toml, templates, tests,
docs) never needs elevation. The admin password is only required when the
installer must write into `/Applications/ChatGPT.app` — i.e. after a ChatGPT
app update or an injection change.

## Critical invariants — do not break

1. **Fail-closed matching.** Every matcher must match exactly once
   (`sendRequest=1`, `prewarmThreadStart=1`, one marker region on upgrades)
   before anything is modified. Never loosen this to "make it work" on a new
   build — extend the structural pattern instead.
2. **Never hardcode minified identifier names.** `SEND_RE` group 1 captures
   the timeout constant, `PREWARM_RE` group 1 the prewarm source helper, and
   `IPC_RE` the per-build IPC helper name (verified against `` `codex-home` ``).
   The injection is generated from those captures via the `@IPC@` placeholder.
3. **Post-patch validation counts are exact.** After patching:
   `desktop-model-providers.json` appears exactly 3 times (thread/start +
   settings/update injections, prewarm) and the marker text exactly 2 times
   (one comment per injection site). If you add an injection site, update
   both counts deliberately.
4. **Injection versioning.** The sendRequest injection comment embeds
   `CAPABILITY_TOKEN` (currently `__codexDesktopRequestProviderRoutingV2`).
   Changing the injected behavior requires a new version token — the
   capability check and the in-place upgrade path key off it. Upgrades
   replace the first marker region (sendRequest) via a non-greedy
   `…\*/.*?\}catch\{\}` match.
5. **The bundle is ESM.** Syntax checks must run `node --check`
   (`syntaxCheckBundle` uses `process.execPath`); `vm.Script` cannot parse
   `import` statements.
6. **`matchAll`/iteration requires the `g` flag** on `SEND_RE`, `PREWARM_RE`,
   and `IPC_RE`. Replacers guard `count === 1` so only the first match is
   transformed.
7. **Plist safety.** `savePlist` re-parses the serialized bytes and
   `deepEqual`s them against the in-memory object before writing; keep that
   check. `Info.plist` format (binary vs XML) is preserved.
8. **Model catalog entries for custom providers must not set `tool_mode`.**
   `code_mode_only` (copied from native GPT entries) strips shell/terminal
   tools from agents; omit the field so the standard `shell_type` tools are
   provided.
9.  Any failure after the first file
   mutation must restore the backup and surface the failed-copy path
   (`restoreBackup`). Never leave a half-patched app behind.

## Injection behavior (what the patch actually does)

- `thread/start` and `prewarmThreadStart`: resolve `modelProvider` from
  `~/.codex/desktop-model-providers.json` (`model_providers[slug]` else
  `default_provider`) for new threads.
- `thread/settings/update` and `turn/settings/update` (injection V2): when
  the payload changes `model` without an explicit `modelProvider`, resolve
  the provider the same way — this is what makes mid-thread provider swaps
  work. Native slugs fall back to `default_provider` (e.g. `openai`).
- `thread/list`: injects an empty `modelProviders` filter so threads from all
  providers stay visible.
- The routing file is re-read on every request; editing it never requires a
  repatch.

## Elevation and safety

- The app bundle is user-owned, but writes into the registered bundle fail
  with `EPERM` (macOS App Management / provenance). Root bypasses this; the
  patcher chowns created files back to the invoking user. The wrapper script
  obtains elevation via the native macOS dialog (`osascript ... with
  administrator privileges`).
- The installer refuses to touch an app whose ASAR header hash does not
  match `Info.plist` integrity metadata, and refuses unknown layouts instead
  of patching blindly.
- Full backups land in `~/Applications/ChatGPT Patch Backups/` (timestamped,
  complete `ditto` copies).

## Secrets and credentials

- **Never commit API keys.** Providers authenticate via `env_key`
  (`GLM_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`) resolved from the
  process environment — injected for GUI apps with `launchctl setenv`
  (machine-local LaunchAgent). Keys live outside this repository.
- Do not run auth-mutating commands (`codex login`, keychain writes for
  provider keys) as part of automated work.

## Conventions

- Node >= 18, ESM (`type: "module"`). Keep the CLI thin; logic belongs in
  `lib/patcher.mjs` and must stay covered by `test/`.
- The upstream README sections (provider configuration, model catalog) are
  kept for reference; fork-specific behavior is documented in this file and
  in `SETUP.md`. Update `SETUP.md` in the same change as behavior.
- Commit style: short imperative summaries ("Add ...", "Support ...",
  "Fix ..."), body explaining the why for behavior changes.
- A ChatGPT app update replaces the patch. The installer refuses mismatched
  layouts; see the troubleshooting section of `SETUP.md` for the
  re-extraction workflow when that happens.
