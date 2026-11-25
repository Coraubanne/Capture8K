#!/bin/zsh
set -euo pipefail

version=${1:?version manquante}
archive_url=${2:?archive manquante}
checksum_url=${3:?checksum manquant}
app_target=${4:?application manquante}
resource_dir=${0:A:h}
workspace="$(mktemp -d /tmp/capture8k-update.XXXXXX)"
app_backup="${workspace}/previous-Contents"
restore_required=0

cleanup() {
  if (( restore_required )) && [[ -d "${app_backup}" && ! -e "${app_target}/Contents" ]]; then
    /bin/mv "${app_backup}" "${app_target}/Contents" || true
  fi
  /bin/rm -rf "${workspace}"
}
trap cleanup EXIT

archive="${workspace}/Capture8K-complet-v${version}.zip"
checksum="${archive}.sha256"
/usr/bin/curl -fL --retry 2 --connect-timeout 10 --max-time 180 -o "${archive}" "${archive_url}"
/usr/bin/curl -fL --retry 2 --connect-timeout 10 --max-time 30 -o "${checksum}" "${checksum_url}"
expected="$(/usr/bin/awk 'NR==1 {print tolower($1)}' "${checksum}")"
actual="$(/usr/bin/shasum -a 256 "${archive}" | /usr/bin/awk '{print tolower($1)}')"
[[ "${expected}" == "${actual}" && "${expected}" =~ '^[0-9a-f]{64}$' ]] || { print -u2 "Checksum invalide"; exit 21; }

extract="${workspace}/extracted"
/bin/mkdir -p "${extract}"
/usr/bin/ditto -x -k "${archive}" "${extract}"
source_app="$(/usr/bin/find "${extract}" -maxdepth 3 -type d -name Capture8K.app -print -quit)"
[[ -n "${source_app}" ]] || { print -u2 "Application absente"; exit 22; }
bundle_root="${source_app:h}"
source_chrome="${bundle_root}/Capture8K Chrome"
source_firefox="${bundle_root}/Capture8K Firefox"
source_bridge="${bundle_root}/Creator Bridge"
[[ -d "${source_chrome}" && -d "${source_firefox}" && -d "${source_bridge}" ]] || { print -u2 "Archive incomplète"; exit 23; }

bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "${source_app}/Contents/Info.plist")"
bundle_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "${source_app}/Contents/Info.plist")"
[[ "${bundle_id}" == "com.capture8k.app" && "${bundle_version}" == "${version}" ]] || { print -u2 "Identité invalide"; exit 24; }
/usr/bin/codesign --verify --deep --strict "${source_app}"
for manifest in "${source_chrome}/manifest.json" "${source_firefox}/manifest.json"; do
  /usr/bin/grep -q '"name"[[:space:]]*:[[:space:]]*"Capture8K' "${manifest}" || { print -u2 "Extension invalide"; exit 25; }
  /usr/bin/grep -q '"version"[[:space:]]*:[[:space:]]*"'"${version}"'"' "${manifest}" || { print -u2 "Version extension invalide"; exit 26; }
done
/usr/bin/grep -q '"id"[[:space:]]*:[[:space:]]*"fr.clipflow.premiere.bridge"' "${source_bridge}/manifest.json" || { print -u2 "Creator Bridge invalide"; exit 27; }

replace_directory() {
  local source=$1
  local target=$2
  local staged="${target:h}/.${target:t}.capture8k-new"
  /bin/mkdir -p "${target:h}"
  /bin/rm -rf "${staged}"
  /usr/bin/ditto "${source}" "${staged}"
  /bin/rm -rf "${target}"
  /bin/mv "${staged}" "${target}"
}

canonical_root="${HOME}/Documents/Capture8K"
replace_directory "${source_chrome}" "${canonical_root}/Chrome"
replace_directory "${source_firefox}" "${canonical_root}/Firefox"
while IFS= read -r target; do
  [[ -n "${target}" && -f "${target}/manifest.json" ]] || continue
  /usr/bin/grep -q '"name"[[:space:]]*:[[:space:]]*"Capture8K' "${target}/manifest.json" || continue
  replace_directory "${source_chrome}" "${target}"
done <<< "${CAPTURE8K_CHROME_TARGETS:-}"

bridge_version="$(/usr/bin/sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${source_bridge}/manifest.json" | /usr/bin/head -n 1)"
bridge_root="${HOME}/Library/Application Support/Adobe/UXP/Plugins/External"
bridge_target="${bridge_root}/fr.clipflow.premiere.bridge_${bridge_version}"
replace_directory "${source_bridge}" "${bridge_target}"
for old_bridge in "${bridge_root}"/fr.clipflow.premiere.bridge_*; do
  [[ -d "${old_bridge}" && "${old_bridge}" != "${bridge_target}" ]] || continue
  /usr/bin/grep -q '"id"[[:space:]]*:[[:space:]]*"fr.clipflow.premiere.bridge"' "${old_bridge}/manifest.json" 2>/dev/null && /bin/rm -rf "${old_bridge}"
done

new_contents="${app_target}/.Contents.capture8k-new"
/bin/rm -rf "${new_contents}"
/usr/bin/ditto "${source_app}/Contents" "${new_contents}"
/bin/mv "${app_target}/Contents" "${app_backup}"
restore_required=1
/bin/mv "${new_contents}" "${app_target}/Contents"
/usr/bin/codesign --verify --deep --strict "${app_target}"
restore_required=0

print '{"ok":true,"installed":true}'
