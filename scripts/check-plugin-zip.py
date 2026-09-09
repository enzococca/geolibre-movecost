#!/usr/bin/env python3
"""
Check a packaged plugin .zip against GeoLibre's own install-time rules.

Mirrors `apps/geolibre-desktop/src/lib/plugin-archive-unpack.ts`: how the
manifest is located, which fields must be present, how entry/style paths are
resolved and constrained, and the 50 MB per-asset cap. Reports every reason the
host would reject the archive, rather than stopping at the first.

    python3 scripts/check-plugin-zip.py [build/movecost-0.1.0.zip]

With no argument it checks the most recently built archive in build/.
"""
import glob
import json
import os
import sys
import zipfile

MAX_ASSET_BYTES = 50 * 1024 * 1024


def is_required_string(value):
    """Non-empty, and no leading or trailing whitespace."""
    return isinstance(value, str) and len(value) > 0 and value.strip() == value


def is_engine_list(value):
    return isinstance(value, list) and all(e in ("maplibre", "cesium") for e in value)


def find_manifest_path(names):
    """Root manifest wins; otherwise the shallowest. __MACOSX is ignored."""
    candidates = [
        n for n in names
        if n.endswith("plugin.json") and not n.startswith("__MACOSX/")
        and (n == "plugin.json" or n.endswith("/plugin.json"))
    ]
    if not candidates:
        return None
    if "plugin.json" in candidates:
        return "plugin.json"
    return sorted(candidates, key=lambda n: (n.count("/"), n))[0]


def unsafe_path(value):
    """Mirrors the Rust validate_external_plugin_path rules."""
    if not isinstance(value, str) or not value:
        return "empty"
    if value.startswith("/"):
        return "starts with '/'"
    if "\\" in value:
        return "contains a backslash"
    if ":" in value:
        return "contains a colon"
    for segment in value.split("/"):
        if segment in ("", ".", ".."):
            return f"has an unsafe segment {segment!r}"
    return None


def main(path):
    problems = []
    notes = []

    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        notes.append(f"{len(infos)} entries")

        manifest_path = find_manifest_path(names)
        if not manifest_path:
            problems.append("Plugin archive is missing a plugin.json.")
            return report(path, problems, notes)
        notes.append(f"manifest at {manifest_path!r}")

        prefix = manifest_path[: len(manifest_path) - len("plugin.json")]

        try:
            manifest = json.loads(archive.read(manifest_path).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - report, do not raise
            problems.append(f"Could not parse plugin.json: {exc}")
            return report(path, problems, notes)

        for field in ("id", "name", "version", "entry"):
            if not is_required_string(manifest.get(field)):
                problems.append(
                    f"Plugin manifest is invalid: {field!r} must be a non-empty, "
                    f"untrimmed-free string (got {manifest.get(field)!r})."
                )

        entry = manifest.get("entry")
        if isinstance(entry, str) and not (entry.endswith(".js") or entry.endswith(".mjs")):
            problems.append(f"Plugin manifest is invalid: entry {entry!r} must end in .js or .mjs.")

        style = manifest.get("style")
        if style is not None and not (isinstance(style, str) and style.endswith(".css")):
            problems.append(f"Plugin manifest is invalid: style {style!r} must end in .css.")

        description = manifest.get("description")
        if description is not None and not isinstance(description, str):
            problems.append("Plugin manifest is invalid: description must be a string.")

        active = manifest.get("activeByDefault")
        if active is not None:
            if not isinstance(active, bool):
                problems.append("Plugin manifest is invalid: activeByDefault must be a boolean.")
            else:
                problems.append("An external plugin must not set activeByDefault.")

        engines = manifest.get("engines")
        if engines is not None and not is_engine_list(engines):
            problems.append("Plugin manifest is invalid: engines must list only maplibre/cesium.")

        for field in ("entry", "style"):
            value = manifest.get(field)
            if not isinstance(value, str):
                continue
            reason = unsafe_path(value)
            if reason:
                problems.append(f"Plugin manifest {field} must be a relative safe path ({reason}).")
                continue
            key = prefix + value
            if key not in names:
                problems.append(f"Plugin {field} '{value}' is missing from the archive.")
                continue
            size = archive.getinfo(key).file_size
            notes.append(f"{field} -> {key} ({size:,} bytes)")
            if size > MAX_ASSET_BYTES:
                problems.append(f"Could not read {field}: exceeds the 50 MB size limit.")

        # Not a host rule, but the loader rejects a bundle whose exported plugin
        # metadata disagrees with the manifest, which looks the same to a user.
        entry_key = prefix + manifest.get("entry", "")
        if entry_key in names:
            source = archive.read(entry_key).decode("utf-8", "replace")
            for field in ("id", "name", "version"):
                value = manifest.get(field)
                if isinstance(value, str) and f'"{value}"' not in source:
                    notes.append(
                        f"warning: manifest {field} {value!r} not found verbatim in the entry "
                        f"bundle — the loader requires the exported plugin to match"
                    )

        extra = set(manifest) - {
            "id", "name", "version", "entry", "style", "description",
            "activeByDefault", "engines",
        }
        if extra:
            notes.append(f"extra manifest keys (allowed, ignored by the host): {sorted(extra)}")

    return report(path, problems, notes)


def report(path, problems, notes):
    print(f"{path}")
    for note in notes:
        print(f"  · {note}")
    if problems:
        print(f"\n  {len(problems)} problem(s) the host would reject:")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1
    print("\n  ✓ Passes every install-time rule.")
    return 0


def newest_archive():
    archives = glob.glob(os.path.join("build", "*.zip"))
    return max(archives, key=os.path.getmtime) if archives else None


if __name__ == "__main__":
    if len(sys.argv) == 2:
        target = sys.argv[1]
    elif len(sys.argv) == 1:
        target = newest_archive()
        if not target:
            print("No archive in build/. Run: npm run package")
            sys.exit(2)
    else:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(target))
