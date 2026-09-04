# Codex Desktop Custom Providers

An unofficial, **build-agnostic request-layer patch** for the macOS
ChatGPT/Codex desktop app that routes custom model providers (OpenRouter,
DeepSeek, MiniMax, ...) without signing out of your ChatGPT account.

A Node.js port and extension of
[Keksuccino/Better-Codex-App-Custom-Provider-Support](https://github.com/Keksuccino/Better-Codex-App-Custom-Provider-Support)
(request-layer fallback approach from PR #3 by Razkar1). Unlike the upstream
provider-picker patch, this installer does **not** modify the model menu —
the native picker keeps listing models from your `model_catalog_json`, and
providers are resolved per request from `~/.codex/desktop-model-providers.json`.

**What it does:**

- Resolves `modelProvider` for new threads (`thread/start` + prewarm) from an
  exact slug map, falling back to `default_provider` (native models → your
  signed-in ChatGPT account).
- **Mid-thread provider swaps (V2):** changing the model in an existing
  conversation (`thread/settings/update` / `turn/settings/update`) switches
  the provider from the next turn — custom slugs route out, native slugs
  route back to ChatGPT.
- Keeps threads from all providers visible (`thread/list`).
- Captures the per-build minified identifiers (IPC helper, timeout constant,
  prewarm helper) **structurally** — no hardcoded names — and stays
  fail-closed: every structure must match exactly once, with full backup +
  automatic recovery.
- Leaves the permission picker fully independent: changing the permission
  mode works identically on custom and native models, and provider swaps
  never alter a thread's permission state.

**Requirements:** macOS, Node >= 18, ChatGPT installed at
`/Applications/ChatGPT.app`. No Python.

## Quick start

```bash
npm install
npm run patch:dry   # compatibility check — no elevation needed
npm run patch       # patch (complete backup + auto-recovery) — needs elevation
npm test            # behavioral tests of the injection — no elevation
```

Or the one-off wrapper, which asks for the admin password via the native
macOS dialog, detaches if run from inside the app itself (kill → elevated
patch → reopen), and refreshes the fork + `node_modules` first:

```bash
./patch-codex-app.sh          # pull, install deps, patch, reopen
./patch-codex-app.sh --check  # dry-run only
```

The installer closes the target app's processes, creates a complete backup,
patches `app.asar`, updates Electron's ASAR integrity metadata, and applies
an ad-hoc signature. `--help` shows alternate app, config, and backup paths.

## Configuration

Custom Codex providers live in `~/.codex/config.toml`
(`wire_api = "responses"` only — codex ≥ 0.153 removed `chat`):

```toml
model_catalog_json = "/Users/you/.codex/model-catalogs/custom.json"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "GLM_API_KEY"   # name only — the value comes from the environment
wire_api = "responses"
```

Do **not** set a global `model_provider` — the patch selects the provider per
thread and per model change.

The routing file `~/.codex/desktop-model-providers.json` maps model slugs to
provider IDs and is re-read on every request (no repatch after edits):

```json
{
  "version": 1,
  "default_provider": "openai",
  "providers": [
    { "id": "openai",     "label": "ChatGPT / OpenAI", "description": "Uses your signed-in ChatGPT account" },
    { "id": "openrouter", "label": "OpenRouter",       "description": "GLM 5.3 models [model_providers.openrouter]" }
  ],
  "model_providers": {
    "glm-5.3-flash": "openrouter",
    "glm-5.3": "openrouter"
  }
}
```

Model metadata comes from `model_catalog_json`. **Two traps:**

- The custom catalog **replaces** the bundled one — export the bundled
  catalog and merge your entries into it, or the native models disappear.
- Never set `tool_mode` on custom entries. Bundled GPT entries carry
  `"code_mode_only"`, which strips shell/terminal tools from agents; omit the
  field so the standard shell tools are provided.

Keys belong in the environment (`env_key`), never in these files. The full
key-free configuration guide — providers, routing JSON, catalog merging and
priority sorting, env-based key injection for GUI apps (`launchctl setenv`),
MiniMax token-plan specifics, and troubleshooting — is in
[SETUP.md](SETUP.md). Agent-facing invariants are in [AGENTS.md](AGENTS.md).

## Updates and recovery

ChatGPT updates replace the patch — re-run the installer afterwards. It is
not tied to a fixed app version or archive hash: it patches compatible source
structures and refuses (fail-closed) when a build changes them. Older
injection versions are upgraded in place (no reinstall needed).

Known-good builds: `26.901.20858` (7658), `26.901.22334` (7746). If a future
build is unsupported ("Expected exactly one request bundle, found 0"),
extract the new bundle and adapt the capture regexes (`SEND_RE`,
`PREWARM_RE`, `IPC_RE`) in `lib/patcher.mjs`.

Backups are stored by default in `~/Applications/ChatGPT Patch Backups/`.

**Elevation note:** the bundle is user-owned, but writes into a registered
app bundle fail with `EPERM` (macOS App Management / provenance). Root
bypasses this; the patcher chowns created files back to the invoking user.

## Known limitations

- The native picker is unchanged on this compatibility path (no extra
  provider menu) — routing is driven by the selected model slug.
- The "You're out of Codex and Work usage" upsell banner still appears for
  ChatGPT-account limits (data source: the `/wham/usage` backend response;
  suppression is a designed-but-unbuilt V3 — see SETUP.md).

## Disclaimer

Use this script entirely at your own risk. It modifies the installed ChatGPT
application in an unofficial and unsupported way.

The author and contributors provide no warranty and accept no responsibility
or liability for any problems, damage, or loss caused directly or indirectly
by using this script. This includes, but is not limited to, lost or corrupted
chat history or other data, an unusable or "bricked" application, account
warnings or restrictions, account suspension or banning, security or privacy
issues, and any other direct or consequential damage. Create and verify your
own backups before running the script.

---

_This is an unofficial modification and is not affiliated with or supported
by OpenAI. Upstream project by Keksuccino; request-layer fallback approach by
Razkar1 (PR #3)._
