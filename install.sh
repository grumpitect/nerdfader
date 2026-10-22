#!/bin/bash
# Installs or updates Nerdfader from its latest GitHub release (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/grumpitect/nerdfader/main/install.sh | bash
#
# Downloads the release zip, checks its SHA-256 against the one published in the release notes, and puts the
# extension in ~/Library/Application Support/Nerdfader/extension (replacing an older copy). Browsers load unpacked
# extensions from a folder, so this path stays the same across updates: load it once, and after an update click
# the reload arrow on Nerdfader's card (or restart the browser). Set NERDFADER_DIR to use another folder.
# Only uses tools that ship with macOS.
set -euo pipefail

REPO="grumpitect/nerdfader"
DIR="${NERDFADER_DIR:-$HOME/Library/Application Support/Nerdfader/extension}"
say() { printf '\033[1;35mnerdfader\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. Download the zip from https://github.com/$REPO/releases/latest instead."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

say "finding the latest release..."
curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" -o "$work/release.json" \
  || fail "couldn't reach GitHub."
json() { plutil -extract "$1" raw -o - "$work/release.json" 2>/dev/null; }
tag=$(json tag_name) || fail "couldn't read the release information."
url=""
for i in 0 1 2 3 4 5 6 7 8 9; do
  name=$(json "assets.$i.name") || break
  case "$name" in Nerdfader-*.zip) url=$(json "assets.$i.browser_download_url"); break ;; esac
done
[ -n "$url" ] || fail "release $tag has no Nerdfader zip."
expected=$(json body | sed -n 's/.*SHA-256: `\([0-9a-f]\{64\}\)`.*/\1/p' | head -1)
[ -n "$expected" ] || fail "release $tag has no published SHA-256."

say "downloading $tag..."
curl -fL --progress-bar "$url" -o "$work/Nerdfader.zip"
actual=$(shasum -a 256 "$work/Nerdfader.zip" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || fail "checksum mismatch (expected $expected, got $actual). Nothing was installed."
ditto -x -k "$work/Nerdfader.zip" "$work/unzipped"
[ -f "$work/unzipped/Nerdfader/manifest.json" ] || fail "the zip doesn't contain the Nerdfader extension."

first=1; [ -f "$DIR/manifest.json" ] && first=0
mkdir -p "$(dirname "$DIR")"
rm -rf "${DIR:?}.new"
ditto "$work/unzipped/Nerdfader" "$DIR.new"
rm -rf "${DIR:?}"
mv "$DIR.new" "$DIR"
say "installed $tag in $DIR"

if [ "$first" = 1 ]; then
  say "one more step, in your browser:"
  echo "  1. Open arc://extensions (Arc) or chrome://extensions (Chrome, Brave, Edge...)"
  echo "  2. Turn on Developer mode and click Load unpacked"
  echo "  3. Choose this folder (press Cmd+Shift+G in the file dialog and paste it):"
  echo "     $DIR"
  printf '%s' "$DIR" | pbcopy 2>/dev/null && echo "     (the path is on your clipboard)"
else
  say "updated. Click the reload arrow on Nerdfader's card in arc://extensions, or restart the browser."
fi
