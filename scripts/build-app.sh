#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Meeting Copilot"
BUNDLE_ID="com.christopherrobinson.meeting-copilot"
BUILD_DIR="$PROJECT_DIR/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
VERSION_FILE="$PROJECT_DIR/VERSION"

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
# ProcessSupervisor spawns the server via `/usr/bin/env node` with PATH
# prepended to include /opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin.
# If the shell running this script has a DIFFERENT Node on PATH (common with
# nvm / fnm), npm will compile native modules like better-sqlite3 against an
# ABI the runtime Node can't load — "NODE_MODULE_VERSION" mismatch at
# session.start. Pin to the exact Node ProcessSupervisor will use so the
# bundle is self-consistent.
RUNTIME_NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then
    RUNTIME_NODE="$candidate"
    break
  fi
done
if [ -z "$RUNTIME_NODE" ]; then
  echo "ERROR: No system Node found in /opt/homebrew/bin or /usr/local/bin."
  echo "       Install via \`brew install node\` so the runtime + build use the same ABI."
  exit 1
fi
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

# Verify native modules load under the runtime Node. Catches ABI mismatches
# (NODE_MODULE_VERSION) before the user hits a silent crash on session.start.
if ! "$RUNTIME_NODE" -e "require('$APP_BUNDLE/Contents/Resources/server/node_modules/better-sqlite3')" 2>/dev/null; then
  echo "ERROR: better-sqlite3 native module does not load under $RUNTIME_NODE."
  echo "       The build Node and runtime Node likely have different ABIs."
  echo "       Try:  (cd '$APP_BUNDLE/Contents/Resources/server' && '$RUNTIME_NODE_DIR/npm' rebuild better-sqlite3)"
  exit 1
fi
echo "  Verified: better-sqlite3 loads under runtime Node"

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

# Bundle the Parakeet sidecar script — the DEFAULT transcription backend.
# ProcessSupervisor runs it via `uv run` at launch; uv resolves the script's
# PEP-723 deps + the Parakeet model from the user's caches on first start.
# (whisper-server is still bundled below as the automatic fallback.)
if [ -f "$PROJECT_DIR/scripts/parakeet-server.py" ]; then
  cp "$PROJECT_DIR/scripts/parakeet-server.py" "$APP_BUNDLE/Contents/Resources/parakeet-server.py"
  echo "  Bundled parakeet-server.py (default transcription backend)"
fi

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

# Bundle whisper model if available
WHISPER_MODEL="$HOME/.meeting-copilot/models/ggml-base.en.bin"
if [ -f "$WHISPER_MODEL" ]; then
  mkdir -p "$APP_BUNDLE/Contents/Resources/models"
  cp "$WHISPER_MODEL" "$APP_BUNDLE/Contents/Resources/models/"
  echo "  Bundled whisper model ($(du -h "$WHISPER_MODEL" | cut -f1))"
fi

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
</dict>
</plist>
PLIST

echo "  Bundle assembled: $APP_BUNDLE"

# ── Step 4: Code sign ────────────────────────────────────────────────────
#
# Prefer a stable signing identity so TCC permissions (Screen Recording,
# Microphone) persist across rebuilds. Ad-hoc signing binds permissions to
# the binary's CDHash, which changes every build — macOS silently revokes
# the grant even though the System Settings toggle still shows "on".
#
# Resolution order:
#   1. $CODESIGN_IDENTITY env var (explicit override)
#   2. "Developer ID Application" certificate from login keychain (stable)
#   3. Fallback: ad-hoc (expect permissions to be re-prompted each rebuild)

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

# Create entitlements
ENTITLEMENTS="$BUILD_DIR/entitlements.plist"
cat > "$ENTITLEMENTS" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
PLIST

if [ "$SIGN_IDENTITY" = "-" ]; then
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"
  echo "  Signed (ad-hoc) — TCC permissions will be revoked on next rebuild."
  echo "  To persist permissions, set CODESIGN_IDENTITY or install a 'Developer ID Application' cert."
else
  # NOTE: no --options runtime. Hardened runtime blocks spawning the node
  # child process without extra entitlements (allow-unsigned-executable-memory,
  # disable-library-validation). Only add it back when preparing for notarization.
  codesign --force --deep --sign "$SIGN_IDENTITY" --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"
  echo "  Signed with: $SIGN_IDENTITY"
fi

# ── Step 5: Verify and copy to dist/ ────────────────────────────────────

echo ""
echo "[5/5] Verifying package and creating dist/ copy..."

"$SCRIPT_DIR/verify-app.sh" "$APP_BUNDLE"

# Cleanup staging before copying the final distributable.
rm -rf "$PROD_STAGING"

DIST_DIR="$PROJECT_DIR/dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
ditto "$APP_BUNDLE" "$DIST_DIR/$APP_NAME.app"
"$SCRIPT_DIR/verify-app.sh" "$DIST_DIR/$APP_NAME.app"
echo "  Copied to: $DIST_DIR/$APP_NAME.app"

echo ""
echo "=== Package Complete ==="
echo ""
echo "  Package: dist/$APP_NAME.app"
echo "  Install: ./scripts/ship.sh"
