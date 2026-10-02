#!/bin/bash
# Print the path of the pinned Node binary: the one Node that builds the server,
# runs its tests and the e2e gate, and ships inside the app (Contents/Resources/node).
#
#   NODE="$(./scripts/fetch-node.sh)"      # …/node/v24.21.0/bin/node
#
# One Node everywhere is what ends gotcha #14: better-sqlite3 is compiled once,
# against this binary's ABI, and nothing else ever loads it.
#
# The official darwin-arm64 tarball is checked against the sha256 below before
# it is unpacked, then kept in MC_NODE_CACHE (default
# ~/Library/Caches/meeting-copilot/node), so a build downloads it once and works
# offline after that. `current` there links to the pinned version, which is what
# a dev build of the app (swift run) falls back to.
#
# Bumping Node: take the version and its sha256 from
# https://nodejs.org/dist/vX.Y.Z/SHASUMS256.txt (node-vX.Y.Z-darwin-arm64.tar.gz),
# then rebuild the dev tree's native module (cd server && npm rebuild better-sqlite3
# under the new Node) and run ./scripts/ship.sh. A new MAJOR changes the ABI.
set -euo pipefail

NODE_VERSION="v24.21.0"
NODE_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
NODE_DIST="node-$NODE_VERSION-darwin-arm64"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.gz"

CACHE="${MC_NODE_CACHE:-$HOME/Library/Caches/meeting-copilot/node}"
DEST="$CACHE/$NODE_VERSION"
TARBALL="$CACHE/$NODE_DIST.tar.gz"

say() { echo "  $*" >&2; }
sha256_of() { LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; }
verified() { [ -f "$1" ] && [ "$(sha256_of "$1")" = "$NODE_SHA256" ]; }

link_current() {
  # Swapped in one rename, so a reader never sees the link missing.
  ln -sfn "$NODE_VERSION" "$CACHE/.current.$$"
  mv -f "$CACHE/.current.$$" "$CACHE/current"
}

# The marker says this directory was unpacked from a tarball that passed the check.
if [ -x "$DEST/bin/node" ] && [ "$(cat "$DEST/.tarball-sha256" 2>/dev/null)" = "$NODE_SHA256" ]; then
  [ "$(readlink "$CACHE/current" 2>/dev/null)" = "$NODE_VERSION" ] || link_current
  echo "$DEST/bin/node"
  exit 0
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "fetch-node.sh pins the darwin-arm64 build; this Mac is $(uname -m)." >&2
  exit 1
fi

mkdir -p "$CACHE"
if ! verified "$TARBALL"; then
  rm -f "$TARBALL"
  say "Downloading Node ${NODE_VERSION}…"
  if ! curl --fail --silent --show-error --location --retry 3 --output "$TARBALL.part" "$NODE_URL" 2>&1 | sed 's/^/  /' >&2 \
     || ! verified "$TARBALL.part"; then
    rm -f "$TARBALL.part"
    echo "Couldn't fetch a verified Node $NODE_VERSION from $NODE_URL" >&2
    exit 1
  fi
  mv "$TARBALL.part" "$TARBALL"
fi

STAGE="$(mktemp -d "$CACHE/unpack.XXXXXX")"
tar -xzf "$TARBALL" -C "$STAGE"
if [ ! -x "$STAGE/$NODE_DIST/bin/node" ]; then
  rm -rf "$STAGE"
  echo "Node $NODE_VERSION's tarball did not unpack to $NODE_DIST/bin/node." >&2
  exit 1
fi
printf '%s\n' "$NODE_SHA256" > "$STAGE/$NODE_DIST/.tarball-sha256"
rm -rf "$DEST"
mv "$STAGE/$NODE_DIST" "$DEST"
rm -rf "$STAGE"
link_current
echo "$DEST/bin/node"
