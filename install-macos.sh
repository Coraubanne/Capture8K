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
extension_root="$user_home/Documents/Capture8K"
chrome_destination="$extension_root/Chrome"
firefox_destination="$extension_root/Firefox"
host_path="$app_destination/Contents/MacOS/Capture8KNativeHost"
guard_source="$repo_dir/macos/Resources/com.capture8k.guard.plist"
guard_destination="$user_home/Library/LaunchAgents/com.capture8k.guard.plist"

"$repo_dir/macos/build.sh"
mkdir -p "$user_home/Applications"
ditto --rsrc --extattr --acl "$app_source" "$app_destination"
mkdir -p "$extension_root"
typeset -aU chrome_destinations
chrome_destinations=()
if [[ -n "$extension_id" ]]; then
  for preferences in "$user_home/Library/Application Support/Google/Chrome"/*/'Secure Preferences'(N.); do
    registered="$(plutil -extract "extensions.settings.$extension_id.path" raw -o - "$preferences" 2>/dev/null)" || continue
    [[ "$registered" == "$user_home/"* && -d "$registered" && ! -L "$registered" ]] || continue
    name="$(plutil -extract name raw -o - "$registered/manifest.json" 2>/dev/null)" || continue
    if [[ "$name" == Capture8K ]]; then chrome_destinations+=("$registered"); fi
  done
fi
if (( ! ${#chrome_destinations} )); then chrome_destinations=("$chrome_destination"); fi
for destination in "${chrome_destinations[@]}"; do
  ditto "$repo_dir/extension" "$destination"
done
ditto "$repo_dir/extension-firefox" "$firefox_destination"

mkdir -p "$user_home/Library/LaunchAgents"
sed "s|__CAPTURE8K_EXECUTABLE__|$app_destination/Contents/MacOS/Capture8K|g" \
  "$guard_source" > "$guard_destination"
launchctl bootout "gui/$UID" "$guard_destination" 2>/dev/null || true
if launchctl bootstrap "gui/$UID" "$guard_destination"; then
  launchctl kickstart -k "gui/$UID/com.capture8k.guard" || true
else
  # Repli quand launchd refuse momentanément de recharger un agent déjà connu.
  /usr/bin/open -g "$app_destination"
fi

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

echo "Capture8K installé dans $app_destination"
print -r -- "Chrome : ${(j:, :)chrome_destinations}"
print -r -- "Firefox : $firefox_destination"
