# Better Codex App Custom Provider Support

An unofficial patch for the macOS ChatGPT/Codex desktop app that adds per-task model-provider selection without requiring you to sign out of your ChatGPT account.

The patch:

- Adds a provider section to the model menu.
- Sends the selected provider when a new task starts.
- Maps model IDs to providers automatically.
- Keeps tasks from all configured providers visible.
- Keeps the normal ChatGPT login active for OpenAI models.

This project currently supports **macOS only**.

> [!CAUTION]
> Changing the provider in a running conversation/thread does **not** work. The conversation/thread continues using the provider it started with.

<img width="500" src="https://github.com/user-attachments/assets/9b61e720-35e9-4021-9c6f-bd77e334e471" />
<br>

## Requirements

- macOS
- ChatGPT installed at `/Applications/ChatGPT.app`
- Python 3.9 or newer
- Node.js with `npx`

## Install

<img width="600" src="https://github.com/user-attachments/assets/8800efd1-d490-4bc3-9959-47ddff5a6db8" />

<br>
<br>

<img width="600" src="https://github.com/user-attachments/assets/90461000-8b4b-4632-93cc-125a116b0830" />

<br>
<br>

**This fork ships a Node installer** (the upstream Python instructions no longer apply here):

```bash
npm install
npm run patch:dry   # compatibility check
npm run patch       # patch (backup + auto-recovery) — needs elevation
```

The installer closes processes belonging to the target app, creates a complete backup, patches `app.asar`, updates Electron's ASAR integrity metadata, and applies an ad-hoc signature.

Run `node patch_chatgpt_provider_routing.mjs --help` to see alternate app, config, and backup paths.

## Configure a custom provider

Custom Codex providers belong in `~/.codex/config.toml`. Provider IDs such as `openrouter` are referenced by the patch configuration later.

Example OpenRouter provider:

```toml
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"

[model_providers.openrouter.auth]
command = "/usr/bin/security"
args = ["find-generic-password", "-a", "YOUR_MACOS_USERNAME", "-s", "Codex OpenRouter API Key", "-w"]
timeout_ms = 5000
refresh_interval_ms = 0
```

Replace `YOUR_MACOS_USERNAME`, then add or update the API key in macOS Keychain. The command prompts for the key instead of placing it in shell history:

```bash
security add-generic-password -U -a "$USER" -s "Codex OpenRouter API Key" -w
```

Codex also supports environment-variable authentication with `env_key`. Do not combine `env_key` with a `[model_providers.<id>.auth]` section. For all authentication methods and provider options, see the [Codex custom model provider documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers).

Do not set a global `model_provider` if OpenAI and custom providers should coexist in the desktop app. The patch selects the provider when each new task starts.

## Add custom models to Codex

Codex loads custom model metadata from the file configured by `model_catalog_json`.

1. Export the bundled catalog as a starting point:

   ```bash
   mkdir -p ~/.codex/model-catalogs
   codex debug models --bundled > ~/.codex/model-catalogs/custom.json
   ```

2. Add model objects to the top-level `models` array. Copy an existing entry with similar capabilities, then update its model ID, display name, context window, modalities, reasoning levels, and tool support.

   The model ID is the `slug` value. It must match the model ID expected by the provider, for example:

   ```json
   {
     "slug": "moonshotai/kimi-k3",
     "display_name": "Kimi K3 (OpenRouter)",
     "description": "MoonshotAI Kimi K3 through OpenRouter."
   }
   ```

   Keep the remaining required fields from the copied entry and adjust them to the model's real capabilities. Do not advertise unsupported tools, modalities, or context-window sizes.

3. Point Codex at the catalog in `~/.codex/config.toml`:

   ```toml
   model_catalog_json = "/Users/your-name/.codex/model-catalogs/custom.json"
   ```

4. Restart the app after changing `model_catalog_json` or the model catalog.

Use `codex debug models` to inspect the effective catalog Codex sees.

## Configure the patched provider menu

The installer creates:

```text
~/.codex/desktop-model-providers.json
```

Example:

```json
{
  "version": 1,
  "default_provider": "openai",
  "providers": [
    {
      "id": "openai",
      "label": "ChatGPT / OpenAI",
      "description": "Uses your signed-in ChatGPT account"
    },
    {
      "id": "openrouter",
      "label": "OpenRouter",
      "description": "Uses [model_providers.openrouter] from config.toml"
    }
  ],
  "model_providers": {
    "moonshotai/kimi-k3": "openrouter",
    "x-ai/grok-4.5": "openrouter",
    "anthropic/claude-fable-5": "openrouter"
  }
}
```

- `providers` defines the providers displayed in the app menu.
- `model_providers` maps exact model slugs to provider IDs for Automatic mode.
- `default_provider` handles models without an explicit mapping.
- Every custom provider ID must match a `[model_providers.<id>]` section in `config.toml`.
- API keys do not belong in this JSON file.

The app reloads this file when the provider menu opens and before a new task starts. Repatching is not required after editing it.

## Updates and recovery

ChatGPT updates replace the patch. Run the installer again after an update.

The installer is not tied to a fixed app version or archive hash. It patches compatible source structures and stops before modifying the installed app if an update changes the relevant code.

Backups are stored by default in:

```text
~/Applications/ChatGPT Patch Backups/
```

## Disclaimer

Use this script entirely at your own risk. It modifies the installed ChatGPT application in an unofficial and unsupported way.

The author and contributors provide no warranty and accept no responsibility or liability for any problems, damage, or loss caused directly or indirectly by using this script. This includes, but is not limited to, lost or corrupted chat history or other data, an unusable or "bricked" application, account warnings or restrictions, account suspension or banning, security or privacy issues, and any other direct or consequential damage.

Create and verify your own backups before running the script.

---

_This is an unofficial modification and is not affiliated with or supported by OpenAI._

---

## Build-agnostic request-layer installer (this fork)

**Node.js port** (no Python required): `patch_chatgpt_provider_routing.mjs`
is a variant of the build-7658 fallback that does **not** hardcode minified
identifier names. It captures the
per-build identifiers (IPC request helper, timeout constant, prewarm source
helper) structurally at patch time and generates the injection from those
captures, staying fail-closed: every structure must match exactly once.

Install dependencies once (`npm install`, Node >= 18) and run:

```bash
npm run patch:dry        # compatibility check only
npm run patch            # patch (needs admin/sudo — see App Management note)
npm test                 # behavioral tests of the injection (no elevation)
```

The library lives in `lib/patcher.mjs`; the CLI entry is
`patch_chatgpt_provider_routing.mjs`; tests are in `test/`.

The request-layer routing still uses `~/.codex/desktop-model-providers.json`
(`model_providers` slug map + `default_provider`). Because this installer is
not tied to a single bundle hash, it keeps working across app builds as long
as the request-layer code shape survives minifier renames.

Known-good builds: `26.901.20858` (7658), `26.901.22334` (7746).

If a future build is unsupported ("Expected exactly one request bundle, found
0"), extract the new bundle and adapt the capture regexes (`SEND_RE`,
`PREWARM_RE`, `IPC_RE`) in `lib/patcher.mjs`.

### macOS App Management note

The app bundle is user-owned, but writing into a registered app bundle can
fail with `EPERM` (macOS App Management / provenance protection). If the
installer reports `Permission denied` for a non-root account, run it elevated
(`sudo node patch_chatgpt_provider_routing.mjs`, or via
`osascript ... with administrator privileges`). Root writes bypass this
protection; the patcher chowns created backups back to the invoking user.

## One-off wrapper + full setup guide

`patch-codex-app.sh` is a one-off wrapper that asks for the admin password via
the native macOS dialog, detaches when run from inside the app itself (kills
the app, patches elevated, reopens), and can refresh this fork first:

```bash
./patch-codex-app.sh            # pull, patch, reopen
./patch-codex-app.sh --check    # dry-run only
```

A complete, key-free example configuration (providers, routing JSON, model
catalog merging and sorting, env-based key injection for GUI apps, MiniMax
token-plan specifics, troubleshooting) is documented in
[SETUP.md](SETUP.md).
