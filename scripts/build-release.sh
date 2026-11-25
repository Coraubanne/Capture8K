#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_dir=${script_dir:h}
version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$repo_dir/macos/Resources/Info.plist")"
workspace="$(mktemp -d /tmp/capture8k-release.XXXXXX)"
trap '/bin/rm -rf "$workspace"' EXIT
bundle="$workspace/Capture8K complet"
/bin/mkdir -p "$bundle"

"$repo_dir/macos/build.sh" >/dev/null
/usr/bin/ditto "$repo_dir/macos/build/Capture8K.app" "$bundle/Capture8K.app"
/usr/bin/ditto "$repo_dir/extension" "$bundle/Capture8K Chrome"
/usr/bin/ditto "$repo_dir/extension-firefox" "$bundle/Capture8K Firefox"
/usr/bin/ditto "$repo_dir/macos/build/Capture8K.app/Contents/Resources/Creator Bridge" "$bundle/Creator Bridge"
/usr/bin/install -m 755 "$repo_dir/install-macos.sh" "$bundle/install-macos.sh"
/usr/bin/install -m 644 "$repo_dir/macos/Resources/com.capture8k.guard.plist" "$bundle/com.capture8k.guard.plist"
/usr/bin/install -m 644 "$repo_dir/README.md" "$bundle/LISEZ-MOI.md"

archive="$repo_dir/Capture8K-complet-v${version}.zip"
/bin/rm -f "$archive" "$archive.sha256"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
/usr/bin/unzip -tq "$archive"
hash="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
print "${hash}  ${archive:t}" > "$archive.sha256"
print "$archive"
