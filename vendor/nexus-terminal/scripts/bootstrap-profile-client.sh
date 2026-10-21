#!/usr/bin/env bash
# Bootstrap a dsh web profile with every client package it needs at
# runtime. dsh's web profile expects to live inside the dsh monorepo
# and reach all `dsh-*` packages via workspace `link:` paths. The
# dshell sibling-workspace setup runs profiles outside dsh/ as an
# independent pnpm workspace, so the profile does not see any of
# those packages unless we link them in by hand.
#
# This script mirrors dsh's monorepo dependency closure into the
# profile by adding each `@deepseek-ai/dsh-*` runtime dep as a `link:`
# spec pointing at the corresponding dsh/ directory. It does not
# touch any dsh source.
#
# Usage: ./scripts/bootstrap-profile-client.sh [profile-name]
# Default profile: web
#
# Run this AFTER install-into-dsh-profile.sh has registered the dshell
# packages. Re-running is safe: pnpm re-uses the existing symlinks.
set -euo pipefail

PROFILE="${1:-web}"
DSH_ROOT="${DSH_ROOT:-$(cd "$(dirname "$0")/../dsh" && pwd)}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"

if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "Profile directory $PROFILE_DIR does not exist."
  echo "Run 'pnpm dsh web --profile $PROFILE' once to let dsh initialize it."
  exit 1
fi

# Enumerate every dependency declared by @deepseek-ai/dsh-web-app. We
# resolve each name to its physical dsh/ directory so we can hand
# pnpm a `link:` spec per package; pnpm will hoist the resulting
# symlinks under the profile's `node_modules/@deepseek-ai/...` thanks
# to the profile's `nodeLinker: hoisted` setting.

WEB_APP_PKG="$DSH_ROOT/packages/bundle/web-app/package.json"

mapfile -t DEPS < <(node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const all = { ...(p.dependencies || {}), ...(p.peerDependencies || {}) };
  console.log(Object.keys(all).join("\n"));
' "$WEB_APP_PKG")

LINK_ARGS=()
for dep in "${DEPS[@]}"; do
  # Resolve the package directory under dsh/.
  pkg_dir="$(node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const name = process.argv[2];
    const dirs = ["packages/*/*", "apps/*", "vendor/*"];
    // manual walk: glob is not needed for our small set
    function walk(dir) {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === "package.json") {
          try {
            const m = JSON.parse(fs.readFileSync(full, "utf8"));
            if (m.name === name) out.push(path.dirname(full));
          } catch {}
        }
      }
      return out;
    }
    const found = walk(root).filter(p => !p.includes("/node_modules/"));
    if (found.length === 0) process.exit(2);
    console.log(found[0]);
  ' "$DSH_ROOT" "$dep" 2>/dev/null || true)"

  if [[ -z "$pkg_dir" ]]; then
    echo "  ! $dep: not found under $DSH_ROOT, skipping"
    continue
  fi

  # Compute the path relative to the profile directory.
  rel="$(realpath --relative-to="$PROFILE_DIR" "$pkg_dir" 2>/dev/null || echo "$pkg_dir")"
  LINK_ARGS+=("${dep}@link:${rel}")
done

if [[ ${#LINK_ARGS[@]} -eq 0 ]]; then
  echo "No link: specs to add. Aborting."
  exit 1
fi

# Prune first: a `link:` whose target has no manifest is residue.
#
# dsh drops packages between releases, and a dropped package leaves its
# `link:` spec behind — the directory keeps only its gitignored `lib/` and
# `node_modules/`, so a ref change does not remove it and `git status` still
# reports a clean tree. Left alone, the profile keeps pointing at a
# pre-release build, and this script (which only ever adds) would never
# notice: the package is no longer in the web-app closure, so the walk above
# simply skips it. Anything still referenced by a row fails at boot long
# before this runs, so absence of a manifest is the safe test.
echo "Pruning dead link: specs from profile '$PROFILE'..."
DEAD=()
while IFS= read -r name; do
  [[ -n "$name" ]] && DEAD+=("$name")
done < <(node -e '
  const fs = require("fs"), path = require("path");
  const [manifestPath, profileDir] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const all = { ...(m.dependencies || {}), ...(m.devDependencies || {}) };
  for (const [name, spec] of Object.entries(all)) {
    if (!name.startsWith("@deepseek-ai/")) continue;
    if (!String(spec).startsWith("link:")) continue;
    const target = path.resolve(profileDir, String(spec).slice("link:".length));
    if (!fs.existsSync(path.join(target, "package.json"))) console.log(name);
  }
' "$PROFILE_DIR/package.json" "$PROFILE_DIR")

if [[ ${#DEAD[@]} -gt 0 ]]; then
  for name in "${DEAD[@]}"; do echo "  - $name"; done
  ( cd "$PROFILE_DIR" && pnpm remove -w "${DEAD[@]}" 2>&1 | tail -4 )
else
  echo "  (none)"
fi

echo "Linking ${#LINK_ARGS[@]} dsh packages into profile '$PROFILE'..."
( cd "$PROFILE_DIR" && pnpm add -w "${LINK_ARGS[@]}" 2>&1 | tail -8 )

echo "Done. Profile now contains the dsh-web-app dependency closure."