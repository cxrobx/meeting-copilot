#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Meeting Copilot"
BUNDLE_ID="com.christopherrobinson.meeting-copilot"
BUILD_DIR="$PROJECT_DIR/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
VERSION_FILE="$PROJECT_DIR/VERSION"
# shellcheck source=sparkle.conf
. "$SCRIPT_DIR/sparkle.conf"
# MC_FEED_URL points a TEST build at a local appcast (docs/updates.md, the
# real-update test). verify-app.sh refuses such a build unless told it is one,
# so ship.sh and release.sh can never install or publish it.
FEED_URL="${MC_FEED_URL:-$SPARKLE_FEED_URL}"

if [ ! -f "$VERSION_FILE" ]; then
  echo "ERROR: VERSION file not found at $VERSION_FILE" >&2
  exit 1
fi
APP_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "ERROR: VERSION must use numeric dotted notation (for example 0.1.0): $APP_VERSION" >&2
  exit 1
fi

echo "=== Packaging $APP_NAME $APP_VERSION ==="
echo ""

# ── Pin Node ─────────────────────────────────────────────────────────────
#
# The app ships its own Node (Contents/Resources/node), pinned by
# fetch-node.sh, and this same binary compiles the server's native modules.
# Build Node == runtime Node by construction, so better-sqlite3 can never be
# built against an ABI the runtime can't load (gotcha #14), whatever nvm or
# Homebrew has on PATH.
RUNTIME_NODE="$("$SCRIPT_DIR/fetch-node.sh")" || {
  echo "ERROR: Couldn't get the pinned Node (scripts/fetch-node.sh)."
  exit 1
}
RUNTIME_NODE_DIR="$(dirname "$RUNTIME_NODE")"
export PATH="$RUNTIME_NODE_DIR:$PATH"
echo "  Using Node: $RUNTIME_NODE ($("$RUNTIME_NODE" --version))"
echo ""

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Step 1: Build Node.js server ─────────────────────────────────────────

echo "[1/5] Building Node.js server..."
cd "$PROJECT_DIR/server"
npm ci --silent
npx tsc
echo "  Compiled TypeScript → dist/"

# Create production node_modules
PROD_STAGING="$BUILD_DIR/server-staging"
mkdir -p "$PROD_STAGING"
cp package.json package-lock.json "$PROD_STAGING/"
cd "$PROD_STAGING"
npm ci --omit=dev --silent
echo "  Installed production dependencies"

# ── Step 2: Build Swift binary ───────────────────────────────────────────

echo ""
echo "[2/5] Building Swift app (release)..."
cd "$PROJECT_DIR/app/MeetingCopilot"
swift build -c release --quiet 2>&1
SWIFT_BIN="$(swift build -c release --show-bin-path)/MeetingCopilot"
echo "  Built: $SWIFT_BIN"

# ── Step 3: Assemble .app bundle ─────────────────────────────────────────

echo ""
echo "[3/5] Assembling app bundle..."

# Create bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources/server/dist"

# Copy Swift binary
cp "$SWIFT_BIN" "$APP_BUNDLE/Contents/MacOS/MeetingCopilot"

# Embed Sparkle, the version Package.resolved pins. ditto keeps the framework's
# Versions/Current symlinks, which a plain copy flattens and breaks.
SPARKLE_FRAMEWORK="$(dirname "$SWIFT_BIN")/Sparkle.framework"
if [ ! -d "$SPARKLE_FRAMEWORK" ]; then
  echo "ERROR: Sparkle.framework not found next to the Swift build ($SPARKLE_FRAMEWORK)."
  exit 1
fi
mkdir -p "$APP_BUNDLE/Contents/Frameworks"
ditto "$SPARKLE_FRAMEWORK" "$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
echo "  Embedded Sparkle $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SPARKLE_FRAMEWORK/Versions/B/Resources/Info.plist")"

# Rewrite libwhisper's install name from the Homebrew absolute path to
# @rpath so the runtime loader picks up the BUNDLED dylib under
# Contents/Resources/whisper/lib/ (via the rpath compiled into the
# binary in Package.swift: @loader_path/../Resources/whisper/lib).
# Without this, the binary holds a hard dep on
# /opt/homebrew/opt/whisper-cpp/libexec/lib/libwhisper.1.dylib, which
# doesn't exist on non-dev machines and causes dyld to refuse to load
# the app. Verified empty-string is a safe no-op if the path isn't
# linked (grep -q).
MC_BIN="$APP_BUNDLE/Contents/MacOS/MeetingCopilot"
if otool -L "$MC_BIN" | grep -q "whisper-cpp/libexec/lib/libwhisper"; then
  HOMEBREW_WHISPER_PATH="$(otool -L "$MC_BIN" | awk '/libwhisper.*dylib/ {print $1; exit}')"
  if [ -n "$HOMEBREW_WHISPER_PATH" ]; then
    install_name_tool -change \
      "$HOMEBREW_WHISPER_PATH" \
      "@rpath/$(basename "$HOMEBREW_WHISPER_PATH")" \
      "$MC_BIN"
    echo "  Rewrote libwhisper install name: $HOMEBREW_WHISPER_PATH → @rpath"
  fi
fi
# Verify post-fix: no absolute Homebrew whisper references remain.
if otool -L "$MC_BIN" | grep -q "/opt/homebrew/.*whisper"; then
  echo "  ERROR: binary still references absolute Homebrew whisper path:" >&2
  otool -L "$MC_BIN" | grep -i whisper >&2
  exit 1
fi

# Copy compiled server
cp -R "$PROJECT_DIR/server/dist/" "$APP_BUNDLE/Contents/Resources/server/dist/"
cp "$PROJECT_DIR/server/package.json" "$APP_BUNDLE/Contents/Resources/server/"

# Copy vendored dashboard assets (marked/DOMPurify/highlight.js/fonts) —
# served at /vendor; index.ts resolves them at dist/../vendor.
if [ ! -f "$PROJECT_DIR/server/vendor/js/marked.min.js" ]; then
  echo "ERROR: server/vendor is missing — run ./scripts/vendor-assets.sh first."
  exit 1
fi
cp -R "$PROJECT_DIR/server/vendor" "$APP_BUNDLE/Contents/Resources/server/vendor"
echo "  Copied vendored dashboard assets"

# Copy production node_modules
cp -R "$PROD_STAGING/node_modules" "$APP_BUNDLE/Contents/Resources/server/"

# Bundle the pinned Node: only the binary and its licence. npm, headers and
# the rest of the distribution are build tools, not runtime.
BUNDLED_NODE="$APP_BUNDLE/Contents/Resources/node/bin/node"
mkdir -p "$(dirname "$BUNDLED_NODE")"
cp "$RUNTIME_NODE" "$BUNDLED_NODE"
cp "$(dirname "$RUNTIME_NODE_DIR")/LICENSE" "$APP_BUNDLE/Contents/Resources/node/LICENSE"
echo "  Bundled Node $("$BUNDLED_NODE" --version)"

# Verify native modules load under the bundled Node. Catches ABI mismatches
# (NODE_MODULE_VERSION) before the user hits a silent crash on session.start.
if ! "$BUNDLED_NODE" -e "require('$APP_BUNDLE/Contents/Resources/server/node_modules/better-sqlite3')" 2>/dev/null; then
  echo "ERROR: better-sqlite3 native module does not load under the bundled Node."
  echo "       Try:  (cd '$APP_BUNDLE/Contents/Resources/server' && '$RUNTIME_NODE_DIR/npm' rebuild better-sqlite3)"
  exit 1
fi
echo "  Verified: better-sqlite3 loads under the bundled Node"

# Copy app icons (icns for Finder, png for in-app usage)
ICON_ICNS="$PROJECT_DIR/app/MeetingCopilot/Resources/AppIcon.icns"
ICON_PNG="$PROJECT_DIR/app/MeetingCopilot/Sources/Resources/AppIcon.png"
if [ -f "$ICON_ICNS" ]; then
  cp "$ICON_ICNS" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
  echo "  Copied app icon (icns)"
fi
if [ -f "$ICON_PNG" ]; then
  cp "$ICON_PNG" "$APP_BUNDLE/Contents/Resources/AppIcon.png"
  echo "  Copied app icon (png)"
fi

# Runtime configuration belongs in ~/.meeting-copilot/.env. Never copy a
# repository-local .env into a distributable app bundle.

# Bundle the Parakeet sidecar — the DEFAULT transcription backend — with the
# pinned uv that runs it and the lock it runs from. ProcessSupervisor runs
# `uv run --frozen --script` at launch; on a Mac that never ran it, uv fetches
# Python 3.12, the locked dependencies and the Parakeet model into the user's
# own caches on first start. (whisper-server is still bundled below as the
# automatic fallback.)
PARAKEET_SCRIPT="$PROJECT_DIR/scripts/parakeet-server.py"
UV_BIN="$("$SCRIPT_DIR/fetch-uv.sh")" || {
  echo "ERROR: Couldn't get the pinned uv (scripts/fetch-uv.sh)."
  exit 1
}
# A stale lock would ship versions the script no longer asks for; --frozen at
# runtime never notices, so refuse it here.
if ! "$UV_BIN" lock --script "$PARAKEET_SCRIPT" --check >/dev/null 2>&1; then
  echo "ERROR: scripts/parakeet-server.py.lock is out of date with the script's dependencies."
  echo "       Run: uv lock --script scripts/parakeet-server.py   (then the transcription eval)"
  exit 1
fi
cp "$PARAKEET_SCRIPT" "$APP_BUNDLE/Contents/Resources/parakeet-server.py"
cp "$PARAKEET_SCRIPT.lock" "$APP_BUNDLE/Contents/Resources/parakeet-server.py.lock"
mkdir -p "$APP_BUNDLE/Contents/Resources/uv/bin"
cp "$UV_BIN" "$APP_BUNDLE/Contents/Resources/uv/bin/uv"
cp "$SCRIPT_DIR/licenses/uv-LICENSE-MIT" "$APP_BUNDLE/Contents/Resources/uv/LICENSE"
echo "  Bundled parakeet-server.py + its lock, and $("$UV_BIN" --version)"

# Bundle whisper-server + its dylib dependencies.
# The homebrew binary is linked with rpath `@loader_path/../lib`, so we preserve
# the layout by copying both bin/ and lib/ from the Cellar's libexec/.
WHISPER_PREFIX="$(brew --prefix whisper-cpp 2>/dev/null || true)"
WHISPER_LIBEXEC=""
if [ -n "$WHISPER_PREFIX" ] && [ -d "$WHISPER_PREFIX/libexec" ]; then
  WHISPER_LIBEXEC="$WHISPER_PREFIX/libexec"
elif [ -d "/opt/homebrew/opt/whisper-cpp/libexec" ]; then
  WHISPER_LIBEXEC="/opt/homebrew/opt/whisper-cpp/libexec"
fi

if [ -n "$WHISPER_LIBEXEC" ] && [ -x "$WHISPER_LIBEXEC/bin/whisper-server" ]; then
  WHISPER_BUNDLE="$APP_BUNDLE/Contents/Resources/whisper"
  mkdir -p "$WHISPER_BUNDLE/bin" "$WHISPER_BUNDLE/lib"
  cp "$WHISPER_LIBEXEC/bin/whisper-server" "$WHISPER_BUNDLE/bin/whisper-server"
  # Copy only the dylibs whisper-server depends on (plus their symlink aliases).
  for name in libwhisper libggml libggml-cpu libggml-blas libggml-metal libggml-base; do
    for f in "$WHISPER_LIBEXEC/lib/$name".*.dylib "$WHISPER_LIBEXEC/lib/$name.dylib"; do
      [ -e "$f" ] && cp -a "$f" "$WHISPER_BUNDLE/lib/"
    done
  done
  LIB_COUNT="$(find "$WHISPER_BUNDLE/lib" -name '*.dylib' | wc -l | tr -d ' ')"
  echo "  Bundled whisper-server + $LIB_COUNT dylib(s) from $WHISPER_LIBEXEC"
else
  echo "  WARNING: whisper-cpp not found via Homebrew — bundle will not include whisper-server"
fi

# The whisper model (ggml-base.en, 148 MB) is not bundled: whisper is the
# fallback a Mac with Parakeet never runs, and shipping it would put it in
# every update. ProcessSupervisor downloads it (pinned, sha256-checked) into
# ~/.meeting-copilot/models the first time whisper mode needs it.

# Bundle Silero VAD model if available. Without it, ProcessSupervisor falls
# back to a non-VAD launch (silence hallucinations pass through). Run
# ./scripts/setup.sh to populate ~/.meeting-copilot/models/ first.
VAD_MODEL="$HOME/.meeting-copilot/models/ggml-silero-v5.1.2.bin"
if [ -f "$VAD_MODEL" ]; then
  mkdir -p "$APP_BUNDLE/Contents/Resources/models"
  cp "$VAD_MODEL" "$APP_BUNDLE/Contents/Resources/models/"
  echo "  Bundled Silero VAD model ($(du -h "$VAD_MODEL" | cut -f1))"
else
  echo "  WARNING: Silero VAD model not at $VAD_MODEL — run ./scripts/setup.sh before building. Bundle will launch whisper without VAD."
fi

# PkgInfo
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

# Info.plist
cat > "$APP_BUNDLE/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Meeting Copilot</string>
    <key>CFBundleDisplayName</key>
    <string>Meeting Copilot</string>
    <key>CFBundleIdentifier</key>
PLIST

# Insert bundle ID (use variable)
cat >> "$APP_BUNDLE/Contents/Info.plist" << EOF
    <string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key>
    <string>$APP_VERSION</string>
    <key>CFBundleShortVersionString</key>
    <string>$APP_VERSION</string>
    <key>SUFeedURL</key>
    <string>$FEED_URL</string>
    <key>SUPublicEDKey</key>
    <string>$SPARKLE_PUBLIC_KEY</string>
EOF

cat >> "$APP_BUNDLE/Contents/Info.plist" << 'PLIST'
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>MeetingCopilot</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSScreenCaptureUsageDescription</key>
    <string>Meeting Copilot needs screen recording access to capture meeting audio from your computer.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Meeting Copilot needs microphone access to capture your voice during meetings.</string>
    <key>NSAudioCaptureUsageDescription</key>
    <string>Meeting Copilot records system audio so it can transcribe the other side of meetings and phone calls.</string>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright 2026 Christopher Robinson</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>86400</integer>
    <key>SUAutomaticallyUpdate</key>
    <false/>
    <key>SUVerifyUpdateBeforeExtraction</key>
    <true/>
</dict>
</plist>
PLIST

echo "  Bundle assembled: $APP_BUNDLE"

# ── Self-contained: nothing may point back at this Mac ──────────────────
#
# A downloaded copy has no Homebrew, no /usr/local and no ~/Projects, so any
# load command naming them is a launch failure on someone else's Mac that
# never shows up on this one. verify-app.sh fails the build on any left.

# The dev rpath Package.swift adds so `swift run` finds Homebrew's libwhisper.
while IFS= read -r rpath; do
  install_name_tool -delete_rpath "$rpath" "$MC_BIN"
  echo "  Removed dev rpath $rpath"
done < <(otool -l "$MC_BIN" | awk '/LC_RPATH/ { getline; getline; print $2 }' | grep -E '^/(opt/homebrew|usr/local|Users)/' || true)

# Homebrew's dylibs name themselves by their Cellar path; loaders reach them
# through @rpath anyway, so make the identity say so too.
if [ -d "$APP_BUNDLE/Contents/Resources/whisper/lib" ]; then
  find "$APP_BUNDLE/Contents/Resources/whisper/lib" -type f -name '*.dylib' | while IFS= read -r dylib; do
    id="$(otool -D "$dylib" | tail -n +2)"
    case "$id" in
      /opt/homebrew/*|/usr/local/*) install_name_tool -id "@rpath/$(basename "$id")" "$dylib" 2>/dev/null ;;
    esac
  done
fi

# better-sqlite3's compile leftovers: object files and a test extension the
# server never loads. Unsignable or unsigned Mach-O the notary would reject.
SQLITE_RELEASE="$APP_BUNDLE/Contents/Resources/server/node_modules/better-sqlite3/build/Release"
rm -rf "$SQLITE_RELEASE/obj.target" "$SQLITE_RELEASE/.deps" "$SQLITE_RELEASE/test_extension.node"
# better-sqlite3 13 ships prebuilds for every platform; the app is arm64 only,
# and an x64 Mach-O would only be one more thing to sign and notarize.
SQLITE_PREBUILDS="$APP_BUNDLE/Contents/Resources/server/node_modules/better-sqlite3/prebuilds"
if [ -d "$SQLITE_PREBUILDS" ]; then
  find "$SQLITE_PREBUILDS" -type f ! -name 'darwin-arm64.node' -delete
fi

# ── Step 4: Code sign ────────────────────────────────────────────────────
#
# Prefer a stable signing identity so TCC permissions (Screen Recording,
# Microphone, System Audio Recording) persist across rebuilds. Ad-hoc signing
# binds permissions to the binary's CDHash, which changes every build — macOS
# silently revokes the grant even though the System Settings toggle still
# shows "on". The hardened runtime does not change the designated requirement
# (identifier + Developer ID team), so it keeps the grants too.
#
# Resolution order:
#   1. $CODESIGN_IDENTITY env var (explicit override)
#   2. "Developer ID Application" certificate from login keychain (stable)
#   3. Fallback: ad-hoc (expect permissions to be re-prompted each rebuild)
#
# Every Mach-O is signed on its own, innermost first, with the hardened
# runtime and a secure timestamp (what notarization requires), then the
# bundle around them. Never --deep: it skips Mach-O files under
# Contents/Resources, and applies one set of entitlements to everything.

echo ""
echo "[4/5] Code signing..."

resolve_identity() {
  if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    echo "$CODESIGN_IDENTITY"
    return
  fi
  # Pick the first "Developer ID Application" identity available
  local found
  found="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Developer ID Application' \
    | head -n 1 \
    | sed -n 's/.*) \([0-9A-F]\{40\}\) .*/\1/p')"
  if [ -n "$found" ]; then
    echo "$found"
    return
  fi
  echo "-"
}

SIGN_IDENTITY="$(resolve_identity)"
APP_ENTITLEMENTS="$SCRIPT_DIR/entitlements/app.plist"
NODE_ENTITLEMENTS="$SCRIPT_DIR/entitlements/node.plist"

sign() {
  if [ "$SIGN_IDENTITY" = "-" ]; then
    codesign --force --options runtime --sign - "$@"
  else
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$@"
  fi
}

# 1. Every Mach-O under Resources but Node: whisper's dylibs and server, the
#    native addon, uv. Deepest path first, so nothing is sealed before what
#    it contains.
RESOURCES="$APP_BUNDLE/Contents/Resources"
BUNDLED_NODE="$RESOURCES/node/bin/node"
find "$RESOURCES" -type f -print0 | while IFS= read -r -d '' f; do
  [ "$f" = "$BUNDLED_NODE" ] && continue
  case "$(file -b "$f")" in *Mach-O*) echo "$f" ;; esac
done | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2- | while IFS= read -r f; do
  sign "$f"
done

# 2. Node, with the two JIT entitlements V8 needs (scripts/entitlements/node.plist).
sign --entitlements "$NODE_ENTITLEMENTS" "$BUNDLED_NODE"

# 3. Sparkle's helpers, innermost first, as its documentation gives them for
#    Developer ID: the two XPC services, Autoupdate, Updater.app, then the
#    framework. The downloader keeps the entitlements it was built with.
SPARKLE_B="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$SPARKLE_B/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$SPARKLE_B/XPCServices/Downloader.xpc"
sign "$SPARKLE_B/Autoupdate"
sign "$SPARKLE_B/Updater.app"
sign "$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"

# 4. The app around them.
sign --entitlements "$APP_ENTITLEMENTS" "$APP_BUNDLE"

if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "  Signed (ad-hoc, hardened runtime) — TCC permissions will be revoked on next rebuild."
  echo "  To persist permissions, set CODESIGN_IDENTITY or install a 'Developer ID Application' cert."
else
  echo "  Signed with: $SIGN_IDENTITY (hardened runtime, timestamped)"
fi

# ── Step 5: Verify and copy to dist/ ────────────────────────────────────

echo ""
echo "[5/5] Verifying package and creating dist/ copy..."

VERIFY_ARGS=()
[ -z "${MC_FEED_URL:-}" ] || VERIFY_ARGS+=(--allow-test-feed)
"$SCRIPT_DIR/verify-app.sh" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} "$APP_BUNDLE"

# Cleanup staging before copying the final distributable.
rm -rf "$PROD_STAGING"

DIST_DIR="$PROJECT_DIR/dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
ditto "$APP_BUNDLE" "$DIST_DIR/$APP_NAME.app"
"$SCRIPT_DIR/verify-app.sh" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"} "$DIST_DIR/$APP_NAME.app"
echo "  Copied to: $DIST_DIR/$APP_NAME.app"

echo ""
echo "=== Package Complete ==="
echo ""
echo "  Package: dist/$APP_NAME.app"
echo "  Install: ./scripts/ship.sh"
