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

# Bundle whisper-server binary if available
WHISPER_BIN="/opt/homebrew/bin/whisper-server"
if [ -f "$WHISPER_BIN" ]; then
  cp "$WHISPER_BIN" "$APP_BUNDLE/Contents/Resources/whisper-server"
  echo "  Bundled whisper-server"
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

# ── Step 4: Ad-hoc code sign ─────────────────────────────────────────────

echo ""
echo "[4/6] Code signing (ad-hoc)..."

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

codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"
echo "  Signed (ad-hoc)"

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
