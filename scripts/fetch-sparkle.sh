#!/bin/bash
# Print the path of a directory holding the pinned Sparkle release tools: bin/ with sign_update,
# generate_keys and generate_appcast, which release.sh uses. (The framework the app embeds comes
# from Swift Package Manager, pinned in app/MeetingCopilot/Package.resolved; this is the same release.)
#
#   SPARKLE="$(./scripts/fetch-sparkle.sh)"
#
# The release tarball is checked against the sha256 below before anything is unpacked, and kept in a
# cache (MC_SPARKLE_CACHE, default ~/Library/Caches/meeting-copilot/sparkle), so a build downloads it once. The
# framework binary is never committed. Offline, or if the download is refused, it falls back to a copy
# already unpacked at MC_SPARKLE_LOCAL (default ~/.local/share/sparkle/<version>): its tarball is
# verified the same way when it is there beside it.
#
# Bumping Sparkle: change both values here, the version in scripts/sparkle.conf and Package.swift,
# read the release's CHANGELOG, and run the real-update test
# (docs/updates.md).
set -euo pipefail

SPARKLE_VERSION="2.10.0"
SPARKLE_SHA256="c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"
SPARKLE_URL="https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"

CACHE="${MC_SPARKLE_CACHE:-$HOME/Library/Caches/meeting-copilot/sparkle}"
LOCAL_DIR="${MC_SPARKLE_LOCAL:-$HOME/.local/share/sparkle/$SPARKLE_VERSION}"
DEST="$CACHE/$SPARKLE_VERSION"
TARBALL="$CACHE/Sparkle-$SPARKLE_VERSION.tar.xz"

say() { echo "  $*" >&2; }
sha256_of() { LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; }
is_unpacked() { [ -d "$1/Sparkle.framework" ] && [ -x "$1/bin/sign_update" ] && [ -x "$1/bin/generate_keys" ]; }
verified() { [ -f "$1" ] && [ "$(sha256_of "$1")" = "$SPARKLE_SHA256" ]; }

# The marker says this directory was unpacked from a tarball that passed the check.
if is_unpacked "$DEST" && [ "$(cat "$DEST/.tarball-sha256" 2>/dev/null)" = "$SPARKLE_SHA256" ]; then
  echo "$DEST"
  exit 0
fi

mkdir -p "$CACHE"
SOURCE=""
if verified "$TARBALL"; then
  SOURCE="$TARBALL"
else
  rm -f "$TARBALL"
  say "Downloading Sparkle ${SPARKLE_VERSION}…"
  if curl --fail --silent --show-error --location --retry 3 --output "$TARBALL.part" "$SPARKLE_URL" 2>&1 | sed 's/^/  /' >&2 \
     && verified "$TARBALL.part"; then
    mv "$TARBALL.part" "$TARBALL"
    SOURCE="$TARBALL"
  else
    rm -f "$TARBALL.part"
    say "Couldn't fetch a verified Sparkle $SPARKLE_VERSION from $SPARKLE_URL"
  fi
fi

if [ -z "$SOURCE" ] && verified "$LOCAL_DIR/Sparkle-$SPARKLE_VERSION.tar.xz"; then
  SOURCE="$LOCAL_DIR/Sparkle-$SPARKLE_VERSION.tar.xz"
  say "Using the verified tarball in $LOCAL_DIR"
fi

if [ -n "$SOURCE" ]; then
  STAGE="$(mktemp -d "$CACHE/unpack.XXXXXX")"
  tar -xJf "$SOURCE" -C "$STAGE"
  if ! is_unpacked "$STAGE"; then
    rm -rf "$STAGE"
    echo "Sparkle $SPARKLE_VERSION's tarball did not unpack to Sparkle.framework and bin/." >&2
    exit 1
  fi
  printf '%s\n' "$SPARKLE_SHA256" > "$STAGE/.tarball-sha256"
  rm -rf "$DEST"
  mv "$STAGE" "$DEST"
  echo "$DEST"
  exit 0
fi

# Last resort: the unpacked copy, when its framework at least says it is this version.
if is_unpacked "$LOCAL_DIR"; then
  found="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$LOCAL_DIR/Sparkle.framework/Versions/B/Resources/Info.plist" 2>/dev/null || true)"
  if [ "$found" = "$SPARKLE_VERSION" ]; then
    say "Using the unpacked Sparkle $found in $LOCAL_DIR (no tarball to check it against)"
    echo "$LOCAL_DIR"
    exit 0
  fi
fi

echo "No Sparkle $SPARKLE_VERSION available: the download failed and $LOCAL_DIR has no usable copy." >&2
exit 1
