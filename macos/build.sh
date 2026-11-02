#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
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
codesign --force --deep --sign - "$app_root"
echo "$app_root"
