#!/bin/zsh
# Publishes a new Nerdfader release on GitHub.
#
# Usage:
#   ./release.sh            bump the patch version (1.0.0 -> 1.0.1)
#   ./release.sh minor      1.0.1 -> 1.1.0
#   ./release.sh major      1.1.0 -> 2.0.0
#   ./release.sh 1.2.3      set an exact version
#
# Steps: checks the tree is clean and tests pass (npm test; npm run test:real, headless, in Google Chrome; and
# npm run test:real:window, the browser-shortcut test, which briefly opens a Chrome window), bumps "version" in extension/manifest.json, zips the extension
# (a Nerdfader folder ready for "Load unpacked"), commits "Release vX.Y.Z", tags and pushes, and creates the
# GitHub release with the zip attached. Needs the GitHub CLI (`gh`) signed in and `npm install` done once.
set -euo pipefail
cd "${0:A:h}"

MANIFEST=extension/manifest.json
[ -z "$(git status --porcelain)" ] || { echo "error: commit or stash your changes first"; exit 1; }
current=$(plutil -extract version raw -o - "$MANIFEST")
IFS=. read -r ma mi pa <<< "$current"
case "${1:-patch}" in
  patch) version="$ma.$mi.$((pa + 1))" ;;
  minor) version="$ma.$((mi + 1)).0" ;;
  major) version="$((ma + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) version="$1" ;;
  *) echo "usage: ./release.sh [patch|minor|major|X.Y.Z]"; exit 1 ;;
esac
tag="v$version"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "error: $tag already exists"; exit 1; }
echo "Releasing $tag (was $current)"

results=$(npm test 2>&1) || { echo "$results" | tail -30; echo "error: tests failed"; exit 1; }
echo "$results" | grep -E "^ℹ (pass|fail)" | tr '\n' ' '; echo
results=$(npm run test:real 2>&1) || { echo "$results" | tail -30; echo "error: real-Chrome tests failed"; exit 1; }
echo "$results" | grep -E "^ℹ (pass|fail)" | tr '\n' ' '; echo
echo "browser-level shortcut test: a Chrome window may appear in the bottom-left corner for a few seconds"
results=$(npm run test:real:window 2>&1) || { echo "$results" | tail -30; echo "error: real-Chrome tests failed"; exit 1; }
echo "$results" | grep -E "^ℹ (pass|fail)" | tr '\n' ' '; echo
previous=$(git describe --tags --abbrev=0 2>/dev/null || true)
sed -i '' -e "s/^  \"version\": \".*\"/  \"version\": \"$version\"/" "$MANIFEST"
[ "$(plutil -extract version raw -o - "$MANIFEST")" = "$version" ] || { echo "error: couldn't set the version"; exit 1; }

DIST="${TMPDIR:-/tmp}/nerdfader-dist"
rm -rf "$DIST" && mkdir -p "$DIST"
ditto extension "$DIST/Nerdfader"
find "$DIST" -name .DS_Store -delete
ZIP="$DIST/Nerdfader-$version.zip"
(cd "$DIST" && zip -qrX "$ZIP" Nerdfader)
sha=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)

git commit -q --allow-empty -am "Release $tag"   # empty when releasing the version already in the manifest
git tag -a "$tag" -m "Nerdfader $tag"
git push -q origin HEAD "$tag"

changes=$( [ -n "$previous" ] && git log --format='- %s' "$previous..$tag" | grep -v '^- Release v' || echo "- First release")
notes=$(cat <<NOTES
## Install

One command (macOS; puts the extension in \`~/Library/Application Support/Nerdfader/extension\` and updates it later):

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/grumpitect/nerdfader/main/install.sh | bash
\`\`\`

Or by hand: download **Nerdfader-$version.zip** below and unzip it somewhere it can stay.

Then, once:

1. Open \`arc://extensions\` in Arc (or \`chrome://extensions\` in Chrome, Brave, Edge...).
2. Turn on **Developer mode**, click **Load unpacked** and choose the **Nerdfader** folder.

To update later, replace the folder (the install command does that) and click the reload arrow on Nerdfader's
card, or restart the browser. Your settings stay.

## Changes

$changes

SHA-256: \`$sha\`
NOTES
)
gh release create "$tag" "$ZIP" --title "Nerdfader $tag" --notes "$notes"
echo "released $tag: $(gh release view "$tag" --json url --jq .url)"
