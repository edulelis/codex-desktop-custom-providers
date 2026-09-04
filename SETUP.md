# Custom provider setup guide

This documents a complete, working setup of the request-layer provider
routing patch: native ChatGPT/OpenAI models and custom models
(GLM via OpenRouter, DeepSeek, MiniMax) sharing one model picker on the
macOS ChatGPT/Codex desktop app.

No API keys appear anywhere in this repository. Keys are referenced by
environment-variable name only.

---

## How the pieces fit together

| File | Role |
|---|---|
| `/Applications/ChatGPT.app` (patched) | Injects `modelProvider` at `thread/start` and `thread/list` |
| `~/.codex/desktop-model-providers.json` | Maps exact model slugs → provider ids; re-read by the app for every new thread |
| `~/.codex/config.toml` | `[model_providers.<id>]` definitions (base URL, auth, wire API) |
| `~/.codex/model-catalogs/custom.json` | Model catalog shown in the native picker (set via `model_catalog_json`) |
| Environment | API keys, injected into GUI apps via `launchctl setenv` |

## 1. Patch the app

Requires Node >= 18 and a one-time `npm install` in the repository.

```bash
npm run patch:dry   # compatibility check
npm run patch       # patch (backup + auto-recovery) — needs elevation
npm test            # behavioral tests of the injection (no elevation)
```

`npm test` also includes a live hash-parity check against the installed app
(ASAR header hash vs `Info.plist` integrity metadata); it skips automatically
when the app bundle is not present.

Or use the bundled wrapper, which asks for the admin password via the native
macOS dialog, detaches if run from inside the app itself, patches elevated,
and reopens the app:

```bash
./patch-codex-app.sh          # pull fork, install deps, patch, reopen
./patch-codex-app.sh --check  # dry-run only
```

> **No elevation is needed** for day-to-day work: editing
> `desktop-model-providers.json`, the model catalog, `config.toml`, running
> tests, or dry-runs all work as the normal user. The admin password is only
> required when the installer must write into `/Applications/ChatGPT.app`
> (i.e. after an app update or an injection change).

> **Why elevation?** The bundle is user-owned, but writes into a registered
> app bundle are blocked by macOS App Management (TCC) with `EPERM` — even for
> `touch` of a new file it may pass, while `os.replace` over an existing
> protected file (e.g. `app.asar`, which carries `com.apple.provenance`)
> fails. Root bypasses this; the patcher chowns created files back to the
> invoking user. Re-run after every app update (updates replace the patch).

## 2. Define the providers (`~/.codex/config.toml`)

```toml
model_catalog_json = "/Users/<you>/.codex/model-catalogs/custom.json"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "GLM_API_KEY"          # name only — the value comes from the environment
wire_api = "responses"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"

[model_providers.minimax]
name = "MiniMax"
base_url = "https://api.minimax.io/v1"
env_key = "MINIMAX_API_KEY"
wire_api = "responses"
```

Important constraints learned on codex ≥ 0.153:

- `wire_api = "chat"` was **removed**. Every provider must speak the
  Responses API (`wire_api = "responses"`). OpenRouter exposes
  `/v1/responses` (verified for the `glm-5.3*` slugs); DeepSeek and the
  MiniMax token plan both work with `/responses`.
- Do **not** set a global `model_provider = ...` — the patch selects the
  provider per new thread; a global value breaks the coexistence with your
  signed-in ChatGPT account.
- MiniMax: the **token/coding-plan key** works on `https://api.minimax.io/v1`
  (Responses API). A pay-as-you-go platform key authenticates but returns
  `HTTP 402 insufficient balance` if the account has no API credit. The
  coding plan also exposes an Anthropic-wire endpoint, which codex cannot
  speak. Official docs:
  [platform.minimax.io/docs/token-plan/codex](https://platform.minimax.io/docs/token-plan/codex)
  (Markdown at `/docs/token-plan/codex.md`).

## 3. Map models to providers (`~/.codex/desktop-model-providers.json`)

```json
{
  "version": 1,
  "default_provider": "openai",
  "providers": [
    { "id": "openai",     "label": "ChatGPT / OpenAI", "description": "Uses your signed-in ChatGPT account" },
    { "id": "openrouter", "label": "OpenRouter",       "description": "GLM 5.3 models [model_providers.openrouter]" },
    { "id": "deepseek",   "label": "DeepSeek",         "description": "DeepSeek API [model_providers.deepseek]" },
    { "id": "minimax",    "label": "MiniMax",          "description": "MiniMax token plan [model_providers.minimax]" }
  ],
  "model_providers": {
    "glm-5.3-flash": "openrouter",
    "glm-5.3": "openrouter",
    "deepseek-v4-flash": "deepseek",
    "deepseek-v4-pro": "deepseek",
    "MiniMax-M2.7-highspeed": "minimax",
    "MiniMax-M3": "minimax"
  }
}
```

Keys must match the catalog slugs exactly — a mapping whose slug is not in
the catalog can never be selected. The app re-reads this file whenever the
picker opens and on every `thread/start`; no repatch needed after edits.

## 4. Model catalog (`~/.codex/model-catalogs/custom.json`)

**`model_catalog_json` REPLACES the bundled catalog — it does not extend it.**
To keep the native OpenAI models, export the bundled catalog and merge your
custom entries into it:

```bash
codex debug models --bundled > ~/.codex/model-catalogs/bundled-reference.json
```

Then build `custom.json` as `bundled.models + customModels`. Restart the app
after changing the catalog.

Sorting: the picker orders by the `priority` field (lower number = higher in
the list). To group families and sort cheapest-first, assign unique, spaced
priorities, e.g.:

```
1  GPT-5.6-Luna            (native, cheapest visible first)
2  GPT-5.6-Terra
3  GPT-5.6-Sol
11 GLM 5.3 Flash
12 GLM 5.3
13 DeepSeek V4 Flash
14 DeepSeek V4 Pro
15 MiniMax M2.7 Highspeed
16 MiniMax M3
```

**Never set `tool_mode` on custom model entries.** Copying a native GPT
entry brings `"tool_mode": "code_mode_only"` along, which restricts the
agent to JS-REPL (code mode) tools — no shell/terminal. Native GPT models are
trained for code mode; custom-provider agents are not, and end up with no
usable tools. Omit the field (absent/null = standard shell + apply_patch
tools per the entry's `shell_type`).

Entries with `visibility: "hide"` (Daybreak variants, `codex-auto-review`)
stay functional for app internals but never appear in the picker.

When copying a bundled entry as a template for a custom model, adjust the
advertised capabilities honestly: `context_window`, `input_modalities`
(text-only providers → `["text"]`), `use_responses_lite: false`,
`supports_search_tool: false`, and clear OpenAI-specific
`additional_speed_tiers` / `service_tiers`. MiniMax publishes recommended
capability values in their Codex docs (1M context, text+image,
`none`/`high` reasoning levels, `supports_reasoning_summaries: true`,
`shell_type: "shell_command"`).

## 5. API keys without ever writing them into config files

Both provider auth styles work with the patch; `env_key` (used here) keeps
keys out of `config.toml` and out of this repository entirely:

- **Terminal sessions:** the shell rc sources a private env file
  (e.g. `~/.config/codex/model-routing.env`) that exports the key variables.
- **GUI sessions** (the desktop app does not read your shell rc): a per-user
  LaunchAgent runs at login and applies each variable with
  `launchctl setenv VAR "$VAR"`, so the app process inherits them. After
  editing, re-bootstrap the agent and/or run `launchctl setenv` once for an
  immediate effect; verify with `launchctl getenv VAR` (presence, never the
  value).

## 6. Troubleshooting

- **`Expected exactly one request bundle, found 0`** — the app updated and
  the request-layer shape changed. Extract the new bundle
  (`npx @electron/asar extract /Applications/ChatGPT.app/Contents/Resources/app.asar /tmp/app`),
  locate the new minified identifiers, and update the capture regexes
  (`SEND_RE`, `PREWARM_RE`, `IPC_RE`) in `patch_chatgpt_provider_routing.py`.
  Keep the fail-closed exactly-once matching.
- **`Permission denied ... Operation not permitted` during the live swap** —
  App Management/TCC; run elevated (see step 1). The installer restores the
  original app automatically if the mutation fails mid-way.
- **Changed provider does nothing** — routing applies to *new* threads only;
  a running conversation keeps the provider it started with.
- **`HTTP 402` on MiniMax** — wrong key class (pay-as-you-go without credit
  instead of the token-plan key).
- **Native models vanished from the picker** — the catalog file replaced the
  bundled one; re-merge (step 4).

## 7. Mid-thread provider swapping (injection V2)

The request-layer injection also intercepts `thread/settings/update` and
`turn/settings/update` (injection version `V2`, token
`__codexDesktopRequestProviderRoutingV2`). Whenever one of those requests
changes the thread's `model` without an explicit `modelProvider`, the
provider is resolved from `desktop-model-providers.json` exactly like at
`thread/start`:

- Custom slugs (`glm-5.3-flash`, `deepseek-v4-pro`, `MiniMax-M3`, ...) route
  to their mapped provider.
- Unmapped (native) slugs fall back to `default_provider` (`openai`), so
  switching back to a GPT model returns the thread to the signed-in ChatGPT
  account.

Practical effect: in an existing conversation, pick a different model in the
native picker — the provider swap applies from the **next turn** (the
conversation history is provider-agnostic; only subsequent model calls use
the new provider). No repatch is needed to change mappings; the routing file
is re-read on every request.

**Permission-picker independence.** The injection only adds
`modelProvider` to payloads that change the model (guard: `t.model != null`).
Permission-picker changes are sent as `thread/settings/update` payloads with
`sandboxPolicy` / `activePermissionProfile` and no `model` field, so they
always pass through untouched — the picker applies identically to custom and
native models, and provider swaps never alter a thread's permission state.

The installer upgrades older `V1` installs in place: when the app is already
marker-patched but lacks the `V2` token, it rewrites the sendRequest
injection region instead of refusing. No app reinstall is required between
injection versions.

## Usage upsell banner suppression (V4)

The "You're out of Codex and Work usage" banner is fed by the ChatGPT-backend
HTTP response `GET /wham/usage`, parsed by the `['rate-limit-status']`
react-query in `app-initial-*.js` — not by the app-server request path.
Injection V4 therefore patches the queryFn itself: right after the `safeGet`
call it voids `rate_limit_upsell`, `rate_limit_reached_type`,
`model_picker_upsell`, `rate_limit` (the `limit_reached`/`allowed` gates) and
`rate_limit_reset_credits` (the "use one of your rate limit resets" counter)
(structural anchor:
`` let <resp>=await <client>.safeGet(`/wham/usage`,{additionalHeaders:...}) ``
captured with groups, exactly-once match per bundle), so the banner has no
data and never renders. The strip is applied best-effort with its own
capability token (`...V4`); older V1/V2/V3 installs are upgraded in place, and a
missing site only skips the strip (routing is unaffected). Workspace
"out of credits" variants driven by `credits.has_credits` are not stripped.
