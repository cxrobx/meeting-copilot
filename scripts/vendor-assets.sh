#!/bin/bash
# Download the dashboard's third-party assets into server/vendor/ so /present
# works fully offline (and stops leaking every page load to jsdelivr/Google).
# Pinned versions — re-run to refresh, then commit the results.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/server/vendor"
MARKED_VERSION="15.0.12"
DOMPURIFY_VERSION="3.4.11"
HLJS_VERSION="11.11.1"
# google-webfonts-helper mirrors Google Fonts files with stable URLs
GWFH="https://gwfh.mranftl.com/api/fonts/jetbrains-mono"

mkdir -p "$VENDOR/js" "$VENDOR/css" "$VENDOR/fonts"

echo "── JS libraries"
curl -fsSL "https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js" -o "$VENDOR/js/marked.min.js"
curl -fsSL "https://cdn.jsdelivr.net/npm/dompurify@${DOMPURIFY_VERSION}/dist/purify.min.js" -o "$VENDOR/js/purify.min.js"
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HLJS_VERSION}/build/highlight.min.js" -o "$VENDOR/js/highlight.min.js"
# Both hljs themes are vendored: the dashboard ships a light/dark toggle and
# must keep working offline, so the inactive one is disabled in the DOM rather
# than fetched on demand.
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HLJS_VERSION}/build/styles/gruvbox-light.min.css" -o "$VENDOR/css/gruvbox-light.min.css"
curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HLJS_VERSION}/build/styles/gruvbox-dark.min.css" -o "$VENDOR/css/gruvbox-dark.min.css"

echo "── JetBrains Mono (woff2, latin)"
# weights the dashboard uses: 300/400/500/600/700 + 400 italic
curl -fsSL "$GWFH?download=zip&subsets=latin&variants=300,regular,500,600,700,italic&formats=woff2" -o /tmp/jbm.zip
unzip -o -q /tmp/jbm.zip -d "$VENDOR/fonts"
rm -f /tmp/jbm.zip

echo "── fonts.css"
cat > "$VENDOR/css/fonts.css" <<'EOF'
/* JetBrains Mono — vendored (see scripts/vendor-assets.sh) */
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 300; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-300.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-regular.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: italic; font-weight: 400; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-italic.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 500; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-500.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 600; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-600.woff2') format('woff2'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700; font-display: swap; src: url('/vendor/fonts/jetbrains-mono-v24-latin-700.woff2') format('woff2'); }
EOF

echo "── HTML Artifact Kit (the house look for pages that leave the dashboard)"
# The reader page reads the kit live from ~/.claude/docs/html-design; this
# snapshot is the fallback when that directory is missing. Re-run to refresh.
mkdir -p "$VENDOR/artifact-kit"
cp "$HOME/.claude/docs/html-design/style.css" "$HOME/.claude/docs/html-design/template.html" "$VENDOR/artifact-kit/"

echo "── done:"
ls -la "$VENDOR/js" "$VENDOR/css" "$VENDOR/fonts"
