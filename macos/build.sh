#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
if [[ -n "${CREATOR_BRIDGE_DIR:-}" ]]; then
  creator_bridge_dir="$CREATOR_BRIDGE_DIR"
elif [[ -f "$script_dir/../vendor/CreatorBridge/manifest.json" ]]; then
  creator_bridge_dir="$script_dir/../vendor/CreatorBridge"
else
  creator_bridge_dir="$script_dir/../../publish/Capture8K/vendor/CreatorBridge"
fi
build_root="$script_dir/build"
app_root="$build_root/Capture8K.app"
macos_dir="$app_root/Contents/MacOS"
resources_dir="$app_root/Contents/Resources"

mkdir -p "$macos_dir" "$resources_dir"
module_cache="$build_root/ModuleCache"
mkdir -p "$module_cache"
clang -O2 -fobjc-arc -fmodules -fmodules-cache-path="$module_cache" \
  -framework AppKit \
  -I "$script_dir/Sources/Shared" \
  "$script_dir/Sources/Shared/Capture8KShared.m" \
  "$script_dir/Sources/Capture8KApp/main.m" \
  -o "$macos_dir/Capture8K"
clang -O2 -fobjc-arc -fmodules -fmodules-cache-path="$module_cache" \
  -framework AppKit -framework CoreGraphics -framework ImageIO \
  -I "$script_dir/Sources/Shared" \
  "$script_dir/Sources/Shared/Capture8KShared.m" \
  "$script_dir/Sources/Capture8KNativeHost/main.m" \
  -o "$macos_dir/Capture8KNativeHost"
cp "$script_dir/Resources/Info.plist" "$app_root/Contents/Info.plist"
[[ -f "$creator_bridge_dir/manifest.json" ]] || { print -u2 "Creator Bridge introuvable : $creator_bridge_dir"; exit 1; }
rm -rf "$resources_dir/Creator Bridge"
mkdir -p "$resources_dir/Creator Bridge"
for bridge_file in manifest.json index.html index.js styles.css LICENSE; do
  cp "$creator_bridge_dir/$bridge_file" "$resources_dir/Creator Bridge/$bridge_file"
done
cp "$script_dir/Resources/install-update.sh" "$resources_dir/install-update.sh"
cp "$script_dir/Resources/creator-bridge-update.sh" "$resources_dir/creator-bridge-update.sh"
chmod 755 "$resources_dir/install-update.sh"
codesign --force --deep --sign - "$app_root"
echo "$app_root"
