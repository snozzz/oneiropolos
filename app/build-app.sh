#!/bin/bash
# Builds dist/Oneiropolos.app (shown as 守梦人 on Chinese and 夢守 on Japanese systems): the Swift shell plus a copy of
# the program files (used when the project directory is not there).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist/Oneiropolos.app"
VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || echo 0.3.0)"
NODE_BIN="$(command -v node || true)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "› Compiling the Swift shell"
rm -rf "$OUT" "$ROOT/dist/WBLoop.app"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/wbloop"
swiftc -O -swift-version 5 -o "$OUT/Contents/MacOS/Oneiropolos" app/main.swift -framework Cocoa -framework WebKit

echo "› Copying the program files"
cp -R bin src public package.json "$OUT/Contents/Resources/wbloop/"

echo "› Writing Info.plist (project: ${ROOT}, Node: ${NODE_BIN:-not found})"
sed -e "s#__ROOT__#$ROOT#g" -e "s#__NODE__#$NODE_BIN#g" -e "s#__VERSION__#$VERSION#g" app/Info.plist > "$OUT/Contents/Info.plist"
# the Dock and Finder name follows the system language; the interface language is a setting inside the app
names() { printf 'CFBundleName = "%s";\nCFBundleDisplayName = "%s";\n' "$1" "$1"; }
for lang in en Base; do mkdir -p "$OUT/Contents/Resources/$lang.lproj"; names "Oneiropolos" > "$OUT/Contents/Resources/$lang.lproj/InfoPlist.strings"; done
for lang in zh-Hans zh_CN; do mkdir -p "$OUT/Contents/Resources/$lang.lproj"; names "守梦人" > "$OUT/Contents/Resources/$lang.lproj/InfoPlist.strings"; done
mkdir -p "$OUT/Contents/Resources/ja.lproj"; names "夢守" > "$OUT/Contents/Resources/ja.lproj/InfoPlist.strings"

echo "› Making the icon"
# app/AppIcon.png is already fitted to the macOS icon grid (1024 canvas, 824 plate) by app/make-icon.swift from app/icon-source.png
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size app/AppIcon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double app/AppIcon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"

echo "› Signing locally"
codesign --force --deep --sign - "$OUT" >/dev/null 2>&1 || echo "  (signing failed; safe to ignore)"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$OUT" >/dev/null 2>&1 || true

echo "✔ Done: ${OUT}"
echo "  Open: open \"$OUT\"    Install: cp -R \"$OUT\" ~/Applications/"
