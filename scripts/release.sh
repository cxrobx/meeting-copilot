#!/bin/bash
# Make a release: build, sign and notarize the app, sign its update archive for Sparkle, write the
# appcast, check the feed the way an installed copy would, and gather it all in dist/vVERSION.
#
#   secret run -k SPARKLE_ED_PRIVATE_MEETING_COPILOT -- scripts/release.sh 0.2.0
#
# It stops short of publishing. It prints the `gh release create` command, and runs it only when given
# --publish, so the release is one you read first. Nothing is uploaded and no tag is made otherwise.
#
#   --publish      also run the printed gh release create (a clean tree, pushed commit)
#   --allow-dirty  a dry run from a tree with uncommitted work; the result is never publishable
#   --check        run every check that comes before the build (version, notes, tag, identity, notary
#                  profile, signing key) and stop
#
# Needs: a Developer ID Application identity in the keychain (CODESIGN_IDENTITY, or the only one there
# is), a notarytool keychain profile (MC_NOTARY_PROFILE, default "DiskSight"), and the Sparkle EdDSA key
# that matches SUPublicEDKey in scripts/sparkle.conf. Hand the key over as SPARKLE_ED_PRIVATE_MEETING_COPILOT
# (above): it is read into a shell variable and removed from the environment before anything else runs, so
# the build, swiftc and notarytool never see it, and it reaches sign_update on stdin, never argv. Without
# that variable it uses the login Keychain's Sparkle account "meeting-copilot", where macOS may stop to ask
# for the login password. Either way the key is checked against SUPublicEDKey before the build starts.
# Never put the private key in this repo.
#
# The version is the VERSION file's: bump it (and write release-notes/vX.Y.Z.md) in a commit first.
set -euo pipefail

# The key, taken out of the environment at once. A shell variable that is not exported is not inherited.
ED_KEY="${SPARKLE_ED_PRIVATE_MEETING_COPILOT:-}"
unset SPARKLE_ED_PRIVATE_MEETING_COPILOT

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=sparkle.conf
. "$ROOT/scripts/sparkle.conf"
APP_NAME="Meeting Copilot"
ARCH="arm64"
NOTARY_PROFILE="${MC_NOTARY_PROFILE:-DiskSight}"

fail() { echo "✗ $*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2; exit 2; }

VERSION=""
PUBLISH=0
ALLOW_DIRTY=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option $arg" >&2; usage ;;
    *) [ -z "$VERSION" ] || usage; VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "VERSION must look like 0.2.0, not '$VERSION'"
[ "$PUBLISH" = 0 ] || [ "$ALLOW_DIRTY" = 0 ] || fail "--publish and --allow-dirty don't go together: a dry run is never published"
[ "$(uname -m)" = "$ARCH" ] || fail "releases are built on Apple Silicon (the bundled Node, uv and Parakeet are arm64)"

TAG="v$VERSION"
NOTES="release-notes/$TAG.md"

echo "→ Checking $TAG is releasable…"
FILE_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[ "$FILE_VERSION" = "$VERSION" ] || fail "VERSION says $FILE_VERSION, not $VERSION: bump it in a commit first"
[ -f "$NOTES" ] || fail "$NOTES doesn't exist: write the release notes first"
if [ -n "$(git status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" = 1 ]; then
    echo "  ! The tree has uncommitted changes (--allow-dirty): this is a dry run, not a release." >&2
  else
    git status --short >&2
    fail "the git tree is dirty. Commit or stash first (or --allow-dirty for a dry run)."
  fi
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "the tag $TAG already exists"
fi
if command -v gh >/dev/null 2>&1; then
  if gh release view "$TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    fail "a GitHub release for $TAG already exists"
  fi
  # Sparkle only offers a version newer than the one installed: a release that doesn't rise is invisible.
  LATEST="$(gh release view --repo "$GITHUB_REPO" --json tagName --jq .tagName 2>/dev/null | sed 's/^v//' || true)"
  if [ -n "$LATEST" ] && [ "$(printf '%s\n%s\n' "$LATEST" "$VERSION" | sort -V | tail -1)" != "$VERSION" -o "$LATEST" = "$VERSION" ]; then
    fail "$VERSION is not newer than the latest release ($LATEST), so no installed copy would take it"
  fi
fi

IDENTITY="${CODESIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  FOUND="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2}')"
  [ "$(echo "$FOUND" | grep -c .)" = 1 ] || fail "set CODESIGN_IDENTITY: the keychain has $(echo "$FOUND" | grep -c .) Developer ID Application identities, not one"
  IDENTITY="$FOUND"
fi
case "$IDENTITY" in "Developer ID Application:"*) ;; *) fail "'$IDENTITY' is not a Developer ID Application identity" ;; esac
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
  || fail "notarytool can't use the keychain profile '$NOTARY_PROFILE' (set MC_NOTARY_PROFILE)"

SPARKLE_DIR="$("$ROOT/scripts/fetch-sparkle.sh")"
SIGN_UPDATE="$SPARKLE_DIR/bin/sign_update"

# Sparkle's EdDSA signature of a file, on stdout.
sign_file() {
  if [ -n "$ED_KEY" ]; then
    printf '%s' "$ED_KEY" | "$SIGN_UPDATE" --ed-key-file - -p "$1"
  else
    "$SIGN_UPDATE" --account "$SPARKLE_ACCOUNT" -p "$1"
  fi
}

# Before a long build: sign a probe and check it against the public key the app carries, so a missing,
# wrong or unreadable key (or a password prompt nobody is there to answer) fails now, not at the end.
TOOLS="$(mktemp -d "${TMPDIR:-/tmp}/mc-release.XXXXXX")"
# macOS's /bin/bash 3.2 exits 0 when `set -u` aborts a script that has an EXIT
# trap, so an abort would look like a finished release. Only a run that reached
# one of its ends sets RELEASE_FINISHED; anything else exits 1.
RELEASE_FINISHED=0
trap 'status=$?; rm -rf "$TOOLS"; if [ "$status" = 0 ] && [ "$RELEASE_FINISHED" != 1 ]; then echo "✗ release.sh stopped before it finished" >&2; exit 1; fi' EXIT
swiftc -O "$ROOT/scripts/ed25519-verify.swift" -o "$TOOLS/ed25519-verify" 2>/dev/null \
  || fail "couldn't build scripts/ed25519-verify.swift (needs the Xcode command-line tools)"
echo "meeting-copilot release key check" > "$TOOLS/probe"
PROBE_SIGNATURE="$(sign_file "$TOOLS/probe" 2>/dev/null)" \
  || fail "couldn't sign with the Sparkle key. Run under: secret run -k SPARKLE_ED_PRIVATE_MEETING_COPILOT -- $0 $VERSION"
"$TOOLS/ed25519-verify" "$SPARKLE_PUBLIC_KEY" "$TOOLS/probe" "$PROBE_SIGNATURE" \
  || fail "the Sparkle signing key does not match SUPublicEDKey in scripts/sparkle.conf"
echo "  ✓ VERSION is $VERSION, notes written, $TAG is free, identity and notary profile work, the signing key matches"
if [ "$CHECK_ONLY" = 1 ]; then
  echo "✓ Every check before the build passed (--check): nothing was built."
  RELEASE_FINISHED=1
  exit 0
fi

# notarytool submit --wait exits 0 whatever the verdict, so read it, and print the log on a rejection.
notarize() {
  local file="$1" out id
  out="$(xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || true
  echo "$out" | sed 's/^/    /'
  if ! grep -q 'status: Accepted' <<< "$out"; then
    id="$(awk '/^  id: / { print $2; exit }' <<< "$out")"
    [ -z "$id" ] || xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
    fail "notarization of $(basename "$file") was not accepted"
  fi
}

echo "→ Building and signing Meeting Copilot ${VERSION}…"
CODESIGN_IDENTITY="$IDENTITY" "$ROOT/scripts/build-app.sh"
APP="$ROOT/dist/$APP_NAME.app"
"$ROOT/scripts/verify-app.sh" --require-developer-id "$APP"

DIST="$ROOT/dist/$TAG"
rm -rf "$DIST"
mkdir -p "$DIST"
ZIP_NAME="Meeting-Copilot-$VERSION-macOS-$ARCH.zip"
DMG_NAME="Meeting-Copilot-$VERSION-macOS-$ARCH.dmg"
ZIP="$DIST/$ZIP_NAME"
DMG="$DIST/$DMG_NAME"

echo "→ Notarizing the app…"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
notarize "$ZIP"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
# The update archive carries the stapled app, so a copy installed from it opens offline too.
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "→ Making the drag-to-Applications disk image…"
DMG_CONTENTS="$TOOLS/dmg"
mkdir -p "$DMG_CONTENTS"
ditto "$APP" "$DMG_CONTENTS/$APP_NAME.app"
ln -s /Applications "$DMG_CONTENTS/Applications"
hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$DMG_CONTENTS" -format UDZO -ov "$DMG" >/dev/null
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

(
  cd "$DIST"
  LC_ALL=C shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256"
  LC_ALL=C shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256"
)

echo "→ Signing the update archive for Sparkle…"
SIGNATURE="$(sign_file "$ZIP")"
LENGTH="$(stat -f %z "$ZIP")"
[ -n "$SIGNATURE" ] || fail "sign_update produced no signature"

echo "→ Writing the appcast…"
MIN_OS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist")"
python3 - "$DIST/appcast.xml" "$ROOT/$NOTES" "$VERSION" "$GITHUB_REPO" "$ZIP_NAME" "$LENGTH" "$SIGNATURE" "$MIN_OS" <<'PY'
import sys
from email.utils import formatdate
from xml.sax.saxutils import escape, quoteattr

out, notes_path, version, repo, zip_name, length, signature, min_os = sys.argv[1:]
notes = open(notes_path, encoding="utf-8").read().strip()
if "]]>" in notes:
    sys.exit("the release notes contain ']]>', which cannot sit in a CDATA section")
min_os = min_os if min_os.count(".") >= 2 else min_os + ".0"  # Sparkle wants three parts: 14.0.0
url = f"https://github.com/{repo}/releases/download/v{version}/{zip_name}"
# The bundled Node, uv and Parakeet are arm64 only, so an Intel Mac must never be offered this.
xml = f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
    <channel>
        <title>Meeting Copilot</title>
        <link>https://github.com/{repo}/releases</link>
        <description>Meeting Copilot updates</description>
        <language>en</language>
        <item>
            <title>Meeting Copilot {escape(version)}</title>
            <link>https://github.com/{repo}/releases/tag/v{escape(version)}</link>
            <sparkle:version>{escape(version)}</sparkle:version>
            <sparkle:shortVersionString>{escape(version)}</sparkle:shortVersionString>
            <pubDate>{formatdate(usegmt=True)}</pubDate>
            <sparkle:minimumSystemVersion>{escape(min_os)}</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <description sparkle:format="markdown"><![CDATA[
{notes}
]]></description>
            <enclosure url={quoteattr(url)} length={quoteattr(length)} type="application/octet-stream" sparkle:edSignature={quoteattr(signature)} />
        </item>
    </channel>
</rss>
'''
open(out, "w", encoding="utf-8").write(xml)
PY

echo "→ Verifying the feed as an installed copy would…"
"$ROOT/scripts/verify-update-feed.sh" "$DIST/appcast.xml" --expect-version "$VERSION"

FILES=("$DMG" "$DMG.sha256" "$ZIP" "$ZIP.sha256" "$DIST/appcast.xml")
RELEASE_CMD=(gh release create "$TAG" --repo "$GITHUB_REPO" --target "$(git rev-parse HEAD)" --title "Meeting Copilot $VERSION" --notes-file "$ROOT/$NOTES" "${FILES[@]}")

echo ""
echo "✓ Release $VERSION is ready in $DIST"
ls -l "$DIST" | sed 's/^/  /'
echo ""
if [ "$ALLOW_DIRTY" = 1 ]; then
  echo "This was a dry run from a dirty tree (--allow-dirty): do not publish it. Commit, then run this again."
  RELEASE_FINISHED=1
  exit 0
fi
echo "To publish, push the release commit, then run:"
printf '  '; printf '%q ' "${RELEASE_CMD[@]}"; echo ""
if [ "$PUBLISH" = 1 ]; then
  echo "→ --publish given: running it."
  "${RELEASE_CMD[@]}"
else
  echo "(Not run. Re-run with --publish to have this script run it.)"
fi
RELEASE_FINISHED=1
