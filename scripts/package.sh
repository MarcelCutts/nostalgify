#!/bin/sh
# Builds Nostalgify.app into out/ and zips it for release.
#   sh scripts/package.sh            # this Mac's architecture
#   sh scripts/package.sh arm64      # Apple Silicon
#   sh scripts/package.sh x64        # Intel
#   sh scripts/package.sh universal  # both in one (twice the size)
set -e
cd "$(dirname "$0")/.."

ARCH="${1:-$(uname -m)}"
VERSION=$(node -p "require('./package.json').version")

npm run build

npx electron-packager . Nostalgify \
  --platform=darwin --arch="$ARCH" --out=out --overwrite \
  --app-version="$VERSION" --app-bundle-id=local.nostalgify \
  --app-category-type=public.app-category.music \
  --icon=build/icon.icns --extend-info=build/extra.plist \
  --ignore='^/src/renderer/.*\.js$' \
  --ignore='^/(skins|scripts|build|out|\.github)(/|$)' \
  --ignore='^/tests(/|$)' \
  --ignore='^/[^/]+\.md$' --ignore='^/LICENSE$' --ignore='^/\.gitignore$' \
  --ignore='^/node_modules/\.package-lock\.json$'

OUTDIR="out/Nostalgify-darwin-$ARCH"
APP="$OUTDIR/Nostalgify.app"
# Keep Electron's and Chromium's licenses inside the app, plus our own notices.
cp "$OUTDIR/LICENSE" "$APP/Contents/Resources/LICENSE.electron.txt"
cp "$OUTDIR/LICENSES.chromium.html" "$APP/Contents/Resources/"
cp LICENSE "$APP/Contents/Resources/LICENSE.nostalgify.txt"
cp THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"
cp licenses/hls.js.txt "$APP/Contents/Resources/LICENSE.hls.js.txt"
# Ad-hoc signature. Not notarized, so first launch needs right-click > Open.
codesign --force --deep --sign - "$APP"

ZIP="out/Nostalgify-$VERSION-mac-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "Built $APP"
echo "Zipped $ZIP"
