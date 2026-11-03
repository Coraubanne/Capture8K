#!/bin/zsh
set -euo pipefail

extension_id=${1:-}
if [[ -n "$extension_id" && ! "$extension_id" =~ '^[a-p]{32}$' ]]; then
  echo "Usage : ./install-macos.sh [IDENTIFIANT_EXTENSION_CHROME]" >&2
  exit 2
fi

repo_dir=${0:A:h}
app_source="$repo_dir/macos/build/Capture8K.app"
user_home=${HOME:?}
app_destination="$user_home/Applications/Capture8K.app"
host_path="$app_destination/Contents/MacOS/Capture8KNativeHost"

"$repo_dir/macos/build.sh"
mkdir -p "$user_home/Applications"
ditto --rsrc --extattr --acl "$app_source" "$app_destination"

if [[ -n "$extension_id" ]]; then
  chrome_manifest=$(printf '{\n  "name": "com.capture8k.native",\n  "description": "Pont local Capture8K",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' "$host_path" "$extension_id")

  for browser_dir in \
    "$user_home/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
    "$user_home/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  do
    mkdir -p "$browser_dir"
    print -r -- "$chrome_manifest" > "$browser_dir/com.capture8k.native.json"
  done
fi

firefox_dir="$user_home/Library/Application Support/Mozilla/NativeMessagingHosts"
firefox_manifest=$(printf '{\n  "name": "com.capture8k.native",\n  "description": "Pont local Capture8K",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_extensions": ["capture8k@coraubanne"]\n}\n' "$host_path")
mkdir -p "$firefox_dir"
print -r -- "$firefox_manifest" > "$firefox_dir/com.capture8k.native.json"

open -gj "$app_destination"
echo "Capture8K installé dans $app_destination"
