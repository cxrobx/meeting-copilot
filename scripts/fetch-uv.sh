#!/bin/bash
# Print the path of the pinned `uv` binary, the one the app ships
# (Contents/Resources/uv/bin/uv) to run the Parakeet sidecar.
#
#   UV="$(./scripts/fetch-uv.sh)"      # …/uv/0.9.21/uv
#
# Shipping uv is what lets Parakeet run on a Mac that never installed it: on
# first start uv fetches Python 3.12, the sidecar's locked dependencies
# (parakeet-server.py.lock) and the model into the user's own caches.
#
# The release tarball is checked against the sha256 below before it is
# unpacked, then kept in MC_UV_CACHE (default ~/Library/Caches/meeting-copilot/uv),
# so a build downloads it once and works offline after that.
#
# Bumping uv: take the version and the sha256 from
# https://github.com/astral-sh/uv/releases/download/<version>/uv-aarch64-apple-darwin.tar.gz.sha256,
# then check `uv lock --script scripts/parakeet-server.py --check` still passes with it.
set -euo pipefail

UV_VERSION="0.9.21"
UV_SHA256="473977236ef8ac5937c80de08a3599cb6ed6021d0e015e10f88076767877a153"
UV_DIST="uv-aarch64-apple-darwin"
UV_URL="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_DIST.tar.gz"

CACHE="${MC_UV_CACHE:-$HOME/Library/Caches/meeting-copilot/uv}"
DEST="$CACHE/$UV_VERSION"
TARBALL="$CACHE/$UV_DIST-$UV_VERSION.tar.gz"

say() { echo "  $*" >&2; }
sha256_of() { LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; }
verified() { [ -f "$1" ] && [ "$(sha256_of "$1")" = "$UV_SHA256" ]; }

# The marker says this directory was unpacked from a tarball that passed the check.
if [ -x "$DEST/uv" ] && [ "$(cat "$DEST/.tarball-sha256" 2>/dev/null)" = "$UV_SHA256" ]; then
  echo "$DEST/uv"
  exit 0
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "fetch-uv.sh pins the aarch64 build; this Mac is $(uname -m)." >&2
  exit 1
fi

mkdir -p "$CACHE"
if ! verified "$TARBALL"; then
  rm -f "$TARBALL"
  say "Downloading uv ${UV_VERSION}…"
  if ! curl --fail --silent --show-error --location --retry 3 --output "$TARBALL.part" "$UV_URL" 2>&1 | sed 's/^/  /' >&2 \
     || ! verified "$TARBALL.part"; then
    rm -f "$TARBALL.part"
    echo "Couldn't fetch a verified uv $UV_VERSION from $UV_URL" >&2
    exit 1
  fi
  mv "$TARBALL.part" "$TARBALL"
fi

STAGE="$(mktemp -d "$CACHE/unpack.XXXXXX")"
tar -xzf "$TARBALL" -C "$STAGE"
if [ ! -x "$STAGE/$UV_DIST/uv" ]; then
  rm -rf "$STAGE"
  echo "uv $UV_VERSION's tarball did not unpack to $UV_DIST/uv." >&2
  exit 1
fi
printf '%s\n' "$UV_SHA256" > "$STAGE/$UV_DIST/.tarball-sha256"
rm -rf "$DEST"
mv "$STAGE/$UV_DIST" "$DEST"
rm -rf "$STAGE"
echo "$DEST/uv"
