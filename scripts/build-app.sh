#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Meeting Copilot"
BUNDLE_ID="com.christopherrobinson.meeting-copilot"
BUILD_DIR="$PROJECT_DIR/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"

echo "=== Building $APP_NAME ==="
echo ""

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Step 1: Build Node.js server ─────────────────────────────────────────

echo "[1/6] Building Node.js server..."
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
echo "[2/6] Building Swift app (release)..."
cd "$PROJECT_DIR/app/MeetingCopilot"
swift build -c release --quiet 2>&1
SWIFT_BIN="$(swift build -c release --show-bin-path)/MeetingCopilot"
echo "  Built: $SWIFT_BIN"

# ── Step 3: Assemble .app bundle ─────────────────────────────────────────

echo ""
echo "[3/6] Assembling app bundle..."

# Create bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources/server/dist"

# Copy Swift binary
cp "$SWIFT_BIN" "$APP_BUNDLE/Contents/MacOS/MeetingCopilot"

# Copy compiled server
cp -R "$PROJECT_DIR/server/dist/" "$APP_BUNDLE/Contents/Resources/server/dist/"
cp "$PROJECT_DIR/server/package.json" "$APP_BUNDLE/Contents/Resources/server/"

# Copy production node_modules
cp -R "$PROD_STAGING/node_modules" "$APP_BUNDLE/Contents/Resources/server/"

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

# Copy .env if it exists (for API keys)
if [ -f "$PROJECT_DIR/server/.env" ]; then
  cp "$PROJECT_DIR/server/.env" "$APP_BUNDLE/Contents/Resources/server/"
  echo "  Copied .env"
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
EOF

cat >> "$APP_BUNDLE/Contents/Info.plist" << 'PLIST'
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
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
echo "[4/6] Code signing..."

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

# ── Step 5: Install to /Applications ─────────────────────────────────────

echo ""
echo "[5/6] Installing to /Applications..."

DEST="/Applications/$APP_NAME.app"
if [ -d "$DEST" ]; then
  echo "  Removing existing installation..."
  rm -rf "$DEST"
fi

cp -R "$APP_BUNDLE" "$DEST"
echo "  Installed: $DEST"

# Cleanup staging
rm -rf "$PROD_STAGING"

# ── Step 6: Copy to dist/ ───────────────────────────────────────────────

echo ""
echo "[6/6] Creating dist/ copy..."

DIST_DIR="$PROJECT_DIR/dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
cp -R "$APP_BUNDLE" "$DIST_DIR/"
echo "  Copied to: $DIST_DIR/$APP_NAME.app"

echo ""
echo "=== Build Complete ==="
echo ""
echo "  $APP_NAME is now in /Applications."
echo "  Also available at: dist/$APP_NAME.app"
echo "  Launch it from Spotlight or /Applications."
