#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEFAULT_APP="$PROJECT_DIR/dist/Meeting Copilot.app"
EXPECTED_BUNDLE_ID="com.christopherrobinson.meeting-copilot"
REQUIRE_DEVELOPER_ID=false

usage() {
  echo "Usage: $0 [--require-developer-id] [path/to/Meeting Copilot.app]"
}

APP_BUNDLE=""
for arg in "$@"; do
  case "$arg" in
    --require-developer-id)
      REQUIRE_DEVELOPER_ID=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$APP_BUNDLE" ]; then
        echo "ERROR: Only one app path may be supplied." >&2
        usage >&2
        exit 2
      fi
      APP_BUNDLE="$arg"
      ;;
  esac
done

APP_BUNDLE="${APP_BUNDLE:-$DEFAULT_APP}"
VERSION_FILE="$PROJECT_DIR/VERSION"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[ -d "$APP_BUNDLE" ] || fail "App bundle not found: $APP_BUNDLE"
[ -f "$VERSION_FILE" ] || fail "Version file not found: $VERSION_FILE"

APP_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] \
  || fail "VERSION must be numeric dotted notation (for example 0.1.0), got: $APP_VERSION"

required_files=(
  "Contents/Info.plist"
  "Contents/MacOS/MeetingCopilot"
  "Contents/Resources/AppIcon.icns"
  "Contents/Resources/parakeet-server.py"
  "Contents/Resources/server/dist/index.js"
  "Contents/Resources/server/package.json"
  "Contents/Resources/server/vendor/js/marked.min.js"
  "Contents/Resources/server/node_modules/better-sqlite3/package.json"
  "Contents/Resources/whisper/bin/whisper-server"
  "Contents/Resources/models/ggml-base.en.bin"
  "Contents/Resources/models/ggml-silero-v5.1.2.bin"
)

for relative_path in "${required_files[@]}"; do
  [ -f "$APP_BUNDLE/$relative_path" ] \
    || fail "Bundle is incomplete; missing $relative_path"
done

[ ! -e "$APP_BUNDLE/Contents/Resources/server/.env" ] \
  || fail "Bundle contains server/.env; distributable apps must never embed local API keys"

actual_version="$(plutil -extract CFBundleShortVersionString raw -o - "$APP_BUNDLE/Contents/Info.plist")"
[ "$actual_version" = "$APP_VERSION" ] \
  || fail "Bundle version is $actual_version, expected $APP_VERSION from VERSION"

actual_build="$(plutil -extract CFBundleVersion raw -o - "$APP_BUNDLE/Contents/Info.plist")"
[ "$actual_build" = "$APP_VERSION" ] \
  || fail "Bundle build is $actual_build, expected $APP_VERSION from VERSION"

actual_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$APP_BUNDLE/Contents/Info.plist")"
[ "$actual_bundle_id" = "$EXPECTED_BUNDLE_ID" ] \
  || fail "Bundle identifier is $actual_bundle_id, expected $EXPECTED_BUNDLE_ID"

# A missing usage description never fails loudly: without
# NSAudioCaptureUsageDescription macOS skips the prompt and hands the process
# tap zero-filled buffers with noErr, so the other side of every call is
# silently lost (gotcha #20).
for usage_key in NSMicrophoneUsageDescription NSScreenCaptureUsageDescription NSAudioCaptureUsageDescription; do
  plutil -extract "$usage_key" raw -o - "$APP_BUNDLE/Contents/Info.plist" >/dev/null 2>&1 \
    || fail "Info.plist is missing $usage_key"
done

main_binary="$APP_BUNDLE/Contents/MacOS/MeetingCopilot"
if otool -L "$main_binary" | grep -q '/opt/homebrew/.*whisper'; then
  fail "Main binary still contains an absolute Homebrew whisper dependency"
fi

whisper_model_bytes="$(stat -f%z "$APP_BUNDLE/Contents/Resources/models/ggml-base.en.bin")"
[ "$whisper_model_bytes" -ge 100000000 ] \
  || fail "Bundled Whisper model looks truncated ($whisper_model_bytes bytes)"

vad_model_bytes="$(stat -f%z "$APP_BUNDLE/Contents/Resources/models/ggml-silero-v5.1.2.bin")"
[ "$vad_model_bytes" -ge 500000 ] \
  || fail "Bundled VAD model looks truncated ($vad_model_bytes bytes)"

# The app runs the server on its own Node, never the system's (gotcha #14).
BUNDLED_NODE="$APP_BUNDLE/Contents/Resources/node/bin/node"
[ -x "$BUNDLED_NODE" ] || fail "Bundle is incomplete; missing Contents/Resources/node/bin/node"
PINNED_NODE="$("$SCRIPT_DIR/fetch-node.sh")" || fail "Couldn't get the pinned Node (scripts/fetch-node.sh)"
bundled_node_version="$("$BUNDLED_NODE" --version)" \
  || fail "The bundled Node does not run"
[ "$bundled_node_version" = "$("$PINNED_NODE" --version)" ] \
  || fail "The bundled Node is $bundled_node_version, but fetch-node.sh pins $("$PINNED_NODE" --version)"

sqlite_module="$APP_BUNDLE/Contents/Resources/server/node_modules/better-sqlite3"
"$BUNDLED_NODE" -e 'require(process.argv[1])' "$sqlite_module" \
  || fail "Bundled better-sqlite3 does not load under the bundled Node"

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" \
  || fail "Code-signature verification failed"

signature_info="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1)"
if [ "$REQUIRE_DEVELOPER_ID" = true ] \
  && ! grep -q '^Authority=Developer ID Application:' <<< "$signature_info"; then
  fail "A Developer ID signature is required for shipping; ad-hoc signatures reset macOS audio permissions"
fi

echo "Verified Meeting Copilot $APP_VERSION"
echo "  Bundle: $APP_BUNDLE"
echo "  Node:   bundled $bundled_node_version"
if grep -q '^Authority=Developer ID Application:' <<< "$signature_info"; then
  echo "  Sign:   Developer ID"
else
  echo "  Sign:   ad-hoc"
fi
