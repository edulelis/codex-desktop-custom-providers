#!/usr/bin/env python3
"""Build-agnostic request-layer provider routing for ChatGPT/Codex macOS.

Modern Desktop builds can still show custom models through model_catalog_json,
but the provider-picker UI patch no longer matches the current frontend layout.
This compatibility installer leaves the native model picker untouched and
routes providers at thread creation using the project's existing
~/.codex/desktop-model-providers.json file.

The routing file is re-read for every new thread. Exact model slugs use
model_providers; unmapped models use default_provider. Existing threads keep the
provider they started with — except that this installer also intercepts
thread/settings/update and turn/settings/update, so changing the model inside
an existing thread swaps the provider for subsequent turns (custom slugs use
their mapping; native slugs fall back to default_provider, e.g. openai).

Unlike the build-7658 fallback (patch_chatgpt_provider_routing_26901.py), this
installer does NOT hardcode minified identifier names. The request-layer
matcher captures the per-build minified names (IPC helper, timeout constant,
prewarm source helper) structurally at patch time and generates the injection
from those captures. Known-good builds: 26.901.20858 (7658) and
26.901.22334 (7746). The installer stays fail-closed: it patches only when
every expected structure matches exactly once, and it upgrades older marker-
patched installs in place when the injection version changes.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sys
import tempfile

try:
    from patch_chatgpt_providers import (
        PatchError,
        asar_header_hash,
        asar_integrity_hash,
        atomic_replace_file,
        contains_marker,
        ensure_provider_config,
        invoking_user_home,
        load_plist,
        make_backup,
        restore_backup,
        run,
        stop_target_app_processes,
    )
except ModuleNotFoundError as exc:
    if exc.name != "patch_chatgpt_providers":
        raise
    raise SystemExit(
        "patch_chatgpt_provider_routing.py must be kept in the same "
        "directory as patch_chatgpt_providers.py. Download both files (or "
        "clone/download the repository) and run the compatibility installer again."
    ) from exc

PATCH_MARKER = b"__codexDesktopRequestProviderRouting"
MARKER_TEXT = "__codexDesktopRequestProviderRouting"
# Injection version suffix; V2 adds thread/settings-update provider swaps.
INJECTION_VERSION = "V2"
CAPABILITY_TOKEN = MARKER_TEXT + INJECTION_VERSION
ASAR_PACKAGE = "@electron/asar@3.4.1"

DISPATCHER_GUARD = (
    "if(this.dispatchMessage==null)throw Error("
    "`AppServerRequestClient is missing a message dispatcher`);"
)

# Structural matchers. Group 1 captures the per-build minified name so the
# injection can be generated for whatever the current build uses.
SEND_RE = re.compile(
    r"async sendRequest\(e,t,n\)\{" + re.escape(DISPATCHER_GUARD) +
    r"return e===`config/read`\?this\.sendConfigReadRequest\(t,n\):"
    r"this\.enqueueRequest\(e,t,e===`plugin/list`&&n\?\.timeoutMs==null\?"
    r"\{\.\.\.n,timeoutMs:(\w+)\}:n\)\}"
)
PREWARM_RE = re.compile(
    r"async prewarmThreadStart\(e,t\)\{" + re.escape(DISPATCHER_GUARD) +
    r"let n=t\?\.priority\?\?`critical`,r=(\w+)\(`thread/start`,t\?\.source\)"
)
IPC_RE = re.compile(r"(\w+)\(`read-file`,\{params:\{hostId:")

SEND_INJECT_TEMPLATE = (
    "/*" + CAPABILITY_TOKEN + "*/"
    "e===`thread/list`&&(t==null||typeof t!==`object`?t={modelProviders:[]}:"
    "t.modelProviders==null&&(t={...t,modelProviders:[]}));"
    "if(e===`thread/start`&&t!=null&&typeof t===`object`&&t.modelProvider==null)try{"
    "let{codexHome:r}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}}),"
    "i=r.includes(`\\\\`)&&!r.includes(`/`)?`\\\\`:`/`,"
    "a=`${r.replace(/[\\\\/]+$/u,``)}${i}desktop-model-providers.json`,"
    "{contents:o}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:a}}),"
    "s=JSON.parse(o),c=s?.model_providers?.[t.model]??s?.default_provider;"
    "typeof c===`string`&&c.length>0&&(t={...t,modelProvider:c})"
    "}catch{}"
    "if((e===`thread/settings/update`||e===`turn/settings/update`)"
    "&&t!=null&&typeof t===`object`&&t.model!=null&&t.modelProvider==null)try{"
    "let{codexHome:n}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}}),"
    "d=n.includes(`\\\\`)&&!n.includes(`/`)?`\\\\`:`/`,"
    "u=`${n.replace(/[\\\\/]+$/u,``)}${d}desktop-model-providers.json`,"
    "{contents:l}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:u}}),"
    "g=JSON.parse(l),h=g?.model_providers?.[t.model]??g?.default_provider;"
    "typeof h===`string`&&h.length>0&&(t={...t,modelProvider:h})"
    "}catch{}"
)

PREWARM_INJECT_TEMPLATE = (
    "/*" + MARKER_TEXT + "*/"
    "if(e!=null&&typeof e===`object`&&e.modelProvider==null)try{"
    "let{codexHome:n}=await @IPC@(`codex-home`,{params:{hostId:this.hostId}}),"
    "r=n.includes(`\\\\`)&&!n.includes(`/`)?`\\\\`:`/`,"
    "i=`${n.replace(/[\\\\/]+$/u,``)}${r}desktop-model-providers.json`,"
    "{contents:a}=await @IPC@(`read-file`,{params:{hostId:this.hostId,path:i}}),"
    "o=JSON.parse(a),s=o?.model_providers?.[e.model]??o?.default_provider;"
    "typeof s===`string`&&s.length>0&&(e={...e,modelProvider:s})"
    "}catch{}"
)


def parse_args() -> argparse.Namespace:
    home = invoking_user_home()
    configured_codex_home = os.environ.get("CODEX_HOME")
    codex_home = (
        Path(configured_codex_home).expanduser()
        if configured_codex_home
        else home / ".codex"
    )
    parser = argparse.ArgumentParser(
        description=(
            "Install automatic custom-provider routing for ChatGPT/Codex "
            "desktop builds with the current request-layer layout."
        )
    )
    parser.add_argument(
        "--app",
        type=Path,
        default=Path("/Applications/ChatGPT.app"),
        help="ChatGPT.app to patch (default: /Applications/ChatGPT.app)",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=codex_home / "desktop-model-providers.json",
        help="Provider-routing JSON in the effective Codex home",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=home / "Applications" / "ChatGPT Patch Backups",
        help="Directory for complete app backups",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify configuration and build compatibility without modifying the app",
    )
    return parser.parse_args()


def validate_no_global_provider(config_path: Path) -> None:
    codex_config = config_path.parent / "config.toml"
    if not codex_config.is_file():
        raise PatchError(f"Missing Codex config: {codex_config}")
    current_section = None
    for raw_line in codex_config.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line
            continue
        if current_section is None and re.match(r"^model_provider\s*=", line):
            raise PatchError(
                "Remove the top-level `model_provider = ...` line from config.toml; "
                "this fallback selects the provider per new thread."
            )


def resolve_ipc_helper(source: str) -> str:
    """Capture the minified IPC request helper used for file reads.

    The helper is the function invoked as <name>(`read-file`,{params:{hostId:...
    and the same name must appear with `codex-home`, returning {codexHome:...}.
    """
    names = set(IPC_RE.findall(source))
    if len(names) != 1:
        raise PatchError(
            f"Expected exactly one `read-file` IPC helper name, found {sorted(names)}."
        )
    helper = next(iter(names))
    codex_home_hits = len(re.findall(re.escape(helper) + r"\(`codex-home`", source))
    if codex_home_hits < 1:
        raise PatchError(
            f"Captured IPC helper {helper!r} is never used with `codex-home`."
        )
    return helper


def find_request_bundle(assets: Path) -> tuple[Path, str]:
    matches = []
    for path in sorted(assets.glob("*.js")):
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        send_hits = SEND_RE.findall(source)
        prewarm_hits = PREWARM_RE.findall(source)
        if send_hits or prewarm_hits:
            if len(send_hits) != 1 or len(prewarm_hits) != 1:
                raise PatchError(
                    f"{path.name} matches the request layer ambiguously "
                    f"(sendRequest={len(send_hits)}, "
                    f"prewarmThreadStart={len(prewarm_hits)})"
                )
            matches.append((path, source))
    if len(matches) != 1:
        raise PatchError(
            "Expected exactly one request bundle, found "
            f"{len(matches)}. The app build is unsupported, updated, or already modified."
        )
    return matches[0]


def patch_request_bundle(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    ipc_helper = resolve_ipc_helper(source)

    send_injection = SEND_INJECT_TEMPLATE.replace("@IPC@", ipc_helper)
    prewarm_injection = PREWARM_INJECT_TEMPLATE.replace("@IPC@", ipc_helper)

    def replace_send(match: re.Match[str]) -> str:
        prefix = "async sendRequest(e,t,n){" + DISPATCHER_GUARD
        return prefix + send_injection + match.group(0)[len(prefix):]

    def replace_prewarm(match: re.Match[str]) -> str:
        prefix = "async prewarmThreadStart(e,t){" + DISPATCHER_GUARD
        return prefix + prewarm_injection + match.group(0)[len(prefix):]

    patched, send_count = SEND_RE.subn(replace_send, source, count=1)
    patched, prewarm_count = PREWARM_RE.subn(replace_prewarm, patched, count=1)
    if send_count != 1 or prewarm_count != 1:
        raise PatchError(
            f"{path.name} does not match the request layer "
            f"(sendRequest={send_count}, prewarmThreadStart={prewarm_count})"
        )
    if patched.count("desktop-model-providers.json") != 3:
        raise PatchError("Provider-routing injection validation failed")
    if patched.count(MARKER_TEXT) != 2:
        raise PatchError("Provider-routing marker validation failed")
    path.write_text(patched, encoding="utf-8")


def find_patched_bundle(assets: Path) -> Path | None:
    """Return the bundle containing this installer's marker, if any."""
    for path in sorted(assets.glob("*.js")):
        try:
            if MARKER_TEXT in path.read_text(encoding="utf-8"):
                return path
        except UnicodeDecodeError:
            continue
    return None


def upgrade_request_bundle(path: Path) -> None:
    """Upgrade an older marker-patched bundle to the current injection.

    Replaces the sendRequest injection region (marker comment through the
    thread/start `}catch{}`) with the current template, which additionally
    handles provider swaps via thread/settings/update and turn/settings/update.
    The prewarm injection is unchanged between versions.
    """
    source = path.read_text(encoding="utf-8")
    if CAPABILITY_TOKEN in source:
        # Capabilities are already current; nothing to do.
        raise PatchError(
            f"{path.name} already contains the settings/update injection."
        )
    ipc_helper = resolve_ipc_helper(source)
    new_injection = SEND_INJECT_TEMPLATE.replace("@IPC@", ipc_helper)
    region_re = re.compile(re.escape("/*" + MARKER_TEXT) + r"\w*\*/.*?\}catch\{\}", re.DOTALL)
    patched, n = region_re.subn(lambda _: new_injection, source, count=1)
    if n != 1:
        raise PatchError(
            f"{path.name} marker injection region did not match exactly once."
        )
    if patched.count("desktop-model-providers.json") != 3:
        raise PatchError("Provider-routing upgrade validation failed")
    if patched.count(MARKER_TEXT) != 2:
        raise PatchError("Provider-routing upgrade marker validation failed")
    path.write_text(patched, encoding="utf-8")


def patch_app(
    app: Path,
    provider_config: Path,
    backup_dir: Path,
    dry_run: bool,
) -> Path | None:
    info_path = app / "Contents" / "Info.plist"
    resources = app / "Contents" / "Resources"
    asar_path = resources / "app.asar"

    if sys.platform != "darwin":
        raise PatchError("This installer only supports macOS")
    if not app.is_dir() or not info_path.is_file() or not asar_path.is_file():
        raise PatchError(f"Not a supported ChatGPT app bundle: {app}")
    if shutil.which("npx") is None:
        raise PatchError("npx is required. Install Node.js, then run this installer again")

    ensure_provider_config(provider_config, overwrite=False)
    validate_no_global_provider(provider_config)

    info, plist_format = load_plist(info_path)
    version = str(info.get("CFBundleShortVersionString", "unknown"))
    build = str(info.get("CFBundleVersion", "unknown"))
    print(f"[APP] ChatGPT/Codex {version} (build {build})")

    current_hash = asar_header_hash(asar_path)
    expected_hash = asar_integrity_hash(info)
    if current_hash != expected_hash:
        raise PatchError(
            "The ASAR header does not match Info.plist integrity metadata. "
            "Restore or reinstall the official app before applying this patch."
        )
    print("[OK] Original ASAR integrity verified.")

    with tempfile.TemporaryDirectory(prefix="codex-provider-routing-") as temporary:
        work = Path(temporary)
        extracted = work / "app"
        patched_asar = work / "app.asar"
        patched_plist = work / "Info.plist"

        run(
            ["npx", "--yes", ASAR_PACKAGE, "extract", str(asar_path), str(extracted)],
            label="Extracting application resources",
        )
        assets = extracted / "webview" / "assets"
        if not assets.is_dir():
            raise PatchError("Extracted app has no webview/assets directory")

        patched_bundle = find_patched_bundle(assets)
        if patched_bundle is not None:
            previous = patched_bundle.read_text(encoding="utf-8")
            if CAPABILITY_TOKEN in previous:
                print(
                    "[OK] Request-layer provider routing (with mid-thread "
                    "provider swaps) is already installed."
                )
                return None
            target = patched_bundle
            print(f"[OK] Found existing provider-routing patch: {patched_bundle.name}")
            if dry_run:
                print("[OK] Dry run passed. This app can be upgraded in place.")
                return None
            upgrade_request_bundle(patched_bundle)
        else:
            target, source = find_request_bundle(assets)
            ipc_helper = resolve_ipc_helper(source)
            print(f"[OK] Matched request bundle: {target.name}")
            print(f"[OK] Captured per-build identifiers: ipc={ipc_helper}")
            if dry_run:
                print("[OK] Dry run passed. This app is compatible with the fallback patch.")
                return None
            patch_request_bundle(target)
        run(
            ["node", "--check", str(target)],
            label="Syntax-checking the patched bundle",
        )
        run(
            ["npx", "--yes", ASAR_PACKAGE, "pack", str(extracted), str(patched_asar)],
            label="Packing patched application resources",
        )
        if not contains_marker(patched_asar, PATCH_MARKER):
            raise PatchError("Packed ASAR is missing the provider-routing marker")

        patched_header_hash = asar_header_hash(patched_asar)
        info["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = patched_header_hash
        with patched_plist.open("wb") as handle:
            plistlib.dump(info, handle, fmt=plist_format, sort_keys=False)

        backup = make_backup(app, backup_dir, version, build)
        print(f"[OK] Backup created: {backup}")
        live_mutation_started = False
        try:
            live_mutation_started = True
            atomic_replace_file(patched_asar, asar_path)
            atomic_replace_file(patched_plist, info_path)
            run(
                ["/usr/bin/codesign", "--deep", "--force", "--sign", "-", str(app)],
                label="Applying an ad-hoc app signature",
            )
            run(
                [
                    "/usr/bin/codesign",
                    "--verify",
                    "--deep",
                    "--strict",
                    "--verbose=2",
                    str(app),
                ],
                label="Verifying the app signature",
            )
            final_info, _ = load_plist(info_path)
            if asar_header_hash(asar_path) != asar_integrity_hash(final_info):
                raise PatchError("Installed ASAR integrity verification failed")
            if not contains_marker(asar_path, PATCH_MARKER):
                raise PatchError("Installed ASAR is missing the provider-routing marker")
        except Exception:
            if live_mutation_started:
                print(
                    "[RECOVERY] Patch failed after app mutation; restoring backup.",
                    file=sys.stderr,
                )
                try:
                    failed_copy = restore_backup(app, backup)
                    print(
                        f"[RECOVERY] Original app restored. Failed patched copy: {failed_copy}",
                        file=sys.stderr,
                    )
                except Exception as restore_exc:
                    print(
                        f"[RECOVERY ERROR] Automatic restore failed: {restore_exc}",
                        file=sys.stderr,
                    )
                    print(
                        f"[RECOVERY ERROR] Full backup remains at: {backup}",
                        file=sys.stderr,
                    )
            raise

    return backup


def main() -> int:
    args = parse_args()
    app = args.app.expanduser().resolve()
    provider_config = args.config.expanduser().resolve()
    backup_dir = args.backup_dir.expanduser().resolve()
    try:
        if not args.dry_run:
            stop_target_app_processes(app, allow_running=False)
        backup = patch_app(app, provider_config, backup_dir, args.dry_run)
    except PatchError as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1
    except PermissionError as exc:
        print(
            f"\nERROR: Permission denied: {exc}\n"
            "If /Applications/ChatGPT.app is not writable by your account, "
            "rerun this same command with sudo.",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130

    if args.dry_run:
        print("\nNo files were changed.")
        return 0

    print("\nSUCCESS")
    print(f"New threads now resolve modelProvider from: {provider_config}")
    print("Exact mappings use model_providers; unmapped models use default_provider.")
    print("The native model picker is left unchanged on this compatibility path.")
    if backup is not None:
        print(f"Backup: {backup}")
    print(
        "A future app update may replace this patch; this installer will refuse "
        "to patch a changed request-layer layout."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
