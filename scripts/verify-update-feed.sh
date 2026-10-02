#!/usr/bin/env bash
# Verify Meeting Copilot's Sparkle feed end to end, the way an installed copy would trust it.
#
#   scripts/verify-update-feed.sh                      # the production feed (scripts/sparkle.conf)
#   scripts/verify-update-feed.sh https://host/appcast.xml
#   scripts/verify-update-feed.sh dist/v0.2.0          # a local release folder (or its appcast.xml)
#   … --expect-version 0.2.0                           # and its newest item must be this version
#
# For every <item> in the appcast it checks, and fails on the first mismatch:
#   - the feed URL and every enclosure URL are https, and the enclosure is the
#     github.com/<repo> release asset Meeting-Copilot-<version>-macOS-arm64.zip for its own version
#   - the enclosure is downloaded (remote) or found next to the appcast (local), and its
#     size equals the appcast's length
#   - the EdDSA signature verifies against SUPublicEDKey from scripts/sparkle.conf
#     (public key only; this script cannot sign anything)
#   - inside the zip: CFBundleVersion / CFBundleShortVersionString equal the appcast's, and
#     the app carries the same SUPublicEDKey and SUFeedURL, so it can verify the updates
#     that follow it
#   - the app passes scripts/verify-app.sh --require-developer-id (bundled Node and uv,
#     every Mach-O hardened and signed by the team, nothing pointing at the build Mac)
#   - the app is stapled and Gatekeeper calls it Notarized Developer ID
#
# Needs curl, xmllint, ditto, codesign, spctl, xcrun and swiftc.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=sparkle.conf
. "$ROOT/scripts/sparkle.conf"
PLISTBUDDY=/usr/libexec/PlistBuddy

info() { printf '\033[1;33m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[0;32m[OK]\033[0m    %s\n' "$*"; }
die()  { printf '\033[0;31m[FAIL]\033[0m  %s\n' "$*" >&2; exit 1; }

plist_get() { "$PLISTBUDDY" -c "Print :$2" "$1" 2>/dev/null || true; }

for tool in curl xmllint ditto codesign spctl swiftc shasum xcrun; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
done

FEED="$SPARKLE_FEED_URL"
EXPECT_VERSION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --expect-version) EXPECT_VERSION="${2:-}"; shift 2 ;;
        -*) die "unknown option $1" ;;
        *) FEED="$1"; shift ;;
    esac
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/mc-feed.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
swiftc -O "$ROOT/scripts/ed25519-verify.swift" -o "$TMP/ed25519-verify" 2>/dev/null \
    || die "couldn't build scripts/ed25519-verify.swift (needs the Xcode command-line tools)"

fetch() { # fetch URL OUTFILE: https only, including after redirects
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 --max-time 900 -o "$2" "$1"
}

# -- Locate the appcast ------------------------------------------------------------
case "$FEED" in
    http://*)  die "the feed must be https, got $FEED" ;;
    https://*) MODE=remote; XML="$TMP/appcast.xml"
               info "Fetching $FEED"
               fetch "$FEED" "$XML" || die "cannot download the feed: $FEED" ;;
    *://*)     die "unsupported feed scheme: $FEED" ;;
    *)         MODE=local
               if [[ -d "$FEED" ]]; then DIR="$FEED"; XML="$FEED/appcast.xml"
               else DIR="$(dirname "$FEED")"; XML="$FEED"; fi
               [[ -f "$XML" ]] || die "no appcast at $XML"
               DIR="$(cd "$DIR" && pwd)"
               info "Reading $XML (local; enclosures are expected next to it)" ;;
esac
xmllint --noout "$XML" || die "the appcast is not well-formed XML"

xp() { xmllint --xpath "string($1)" "$XML" 2>/dev/null || true; }
COUNT="$(xmllint --xpath 'count(//item)' "$XML")"
[[ "$COUNT" -ge 1 ]] || die "the appcast has no <item>"

# -- Each item ----------------------------------------------------------------------
for i in $(seq 1 "$COUNT"); do
    item="//item[$i]"
    url="$(xp "$item/enclosure/@url")"
    length="$(xp "$item/enclosure/@length")"
    sig="$(xp "$item/enclosure/@*[local-name()='edSignature']")"
    version="$(xp "$item/*[local-name()='version']")"
    short="$(xp "$item/*[local-name()='shortVersionString']")"
    label="item $i (Meeting Copilot ${short:-?})"

    [[ -n "$url" && -n "$length" && -n "$sig" && -n "$version" && -n "$short" ]] \
        || die "$label: needs enclosure url, length, sparkle:edSignature, sparkle:version and sparkle:shortVersionString"
    if [[ "$i" == 1 && -n "$EXPECT_VERSION" && "$short" != "$EXPECT_VERSION" ]]; then
        die "$label: the newest item is $short, expected $EXPECT_VERSION"
    fi
    [[ "$url" == https://* ]] || die "$label: enclosure URL is not https: $url"
    re="^https://github\.com/${GITHUB_REPO//\//\\/}/releases/download/v([0-9]+\.[0-9]+\.[0-9]+)/(Meeting-Copilot-([0-9]+\.[0-9]+\.[0-9]+)-macOS-arm64\.zip)$"
    [[ "$url" =~ $re ]] || die "$label: enclosure is not a $GITHUB_REPO release asset named Meeting-Copilot-X.Y.Z-macOS-arm64.zip: $url"
    [[ "${BASH_REMATCH[1]}" == "$short" && "${BASH_REMATCH[3]}" == "$short" ]] \
        || die "$label: enclosure URL names version ${BASH_REMATCH[1]}/${BASH_REMATCH[3]} but the item says $short"
    name="${BASH_REMATCH[2]}"

    if [[ "$MODE" == remote ]]; then
        zip="$TMP/$name"
        info "$label: downloading $url"
        fetch "$url" "$zip" || die "$label: cannot download $url"
    else
        zip="$DIR/$name"
        [[ -f "$zip" ]] || die "$label: $name is not next to the appcast in $DIR"
    fi

    actual="$(stat -f%z "$zip")"
    [[ "$actual" == "$length" ]] || die "$label: appcast length is $length but $name is $actual bytes"
    ok "$label: $name is $actual bytes, as the appcast says"

    if [[ "$MODE" == local && -f "$zip.sha256" ]]; then
        (cd "$DIR" && shasum -a 256 -c "$name.sha256" >/dev/null 2>&1) || die "$label: $name.sha256 does not match"
        ok "$label: $name.sha256 matches"
    fi

    "$TMP/ed25519-verify" "$SPARKLE_PUBLIC_KEY" "$zip" "$sig" \
        || die "$label: EdDSA signature does not verify against SUPublicEDKey in scripts/sparkle.conf"
    ok "$label: EdDSA signature verifies against SUPublicEDKey"

    out="$TMP/x$i"; mkdir -p "$out"
    ditto -x -k "$zip" "$out" || die "$label: cannot unzip $name"
    app="$out/Meeting Copilot.app"
    [[ -d "$app" ]] || die "$label: $name does not contain Meeting Copilot.app at its top level"
    plist="$app/Contents/Info.plist"
    [[ "$(plist_get "$plist" CFBundleVersion)" == "$version" ]] \
        || die "$label: app CFBundleVersion is '$(plist_get "$plist" CFBundleVersion)', appcast sparkle:version is '$version'"
    [[ "$(plist_get "$plist" CFBundleShortVersionString)" == "$short" ]] \
        || die "$label: app version is '$(plist_get "$plist" CFBundleShortVersionString)', appcast says '$short'"
    [[ "$(plist_get "$plist" SUPublicEDKey)" == "$SPARKLE_PUBLIC_KEY" ]] \
        || die "$label: the app's SUPublicEDKey differs from scripts/sparkle.conf; it could not verify later updates"
    [[ "$(plist_get "$plist" SUFeedURL)" == "$SPARKLE_FEED_URL" ]] \
        || die "$label: the app's SUFeedURL is '$(plist_get "$plist" SUFeedURL)', not $SPARKLE_FEED_URL"
    ok "$label: Info.plist matches the appcast (version $short) and carries the same key and feed"

    # verify-app.sh compares the bundle against the repo's VERSION, so it runs only
    # on the release being made (--expect-version, as release.sh passes it).
    if [[ "$i" == 1 && -n "$EXPECT_VERSION" ]]; then
        "$ROOT/scripts/verify-app.sh" --require-developer-id "$app" >"$TMP/verify.out" 2>&1 \
            || die "$label: verify-app.sh failed: $(tail -3 "$TMP/verify.out")"
        ok "$label: verify-app.sh passes (bundled runtime, hardened signatures, self-contained)"
    fi

    codesign --verify --deep --strict "$app" 2>"$TMP/cs.err" \
        || die "$label: codesign --verify --deep --strict failed: $(cat "$TMP/cs.err")"
    xcrun stapler validate "$app" >/dev/null 2>&1 || die "$label: no stapled notarization ticket on Meeting Copilot.app"
    assess="$(spctl -a -t exec -vv "$app" 2>&1 || true)"
    grep -q 'source=Notarized Developer ID' <<<"$assess" || die "$label: Gatekeeper: $assess"
    ok "$label: code signature valid, stapled, Gatekeeper: Notarized Developer ID"
done

ok "feed verified: $COUNT item(s) ($FEED)"
