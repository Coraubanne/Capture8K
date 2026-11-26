#!/bin/zsh
set -euo pipefail

version=${1:?version manquante}
archive_url=${2:?archive manquante}
checksum_url=${3:?checksum manquant}
app_target=${4:?application manquante}
install_home=${5:-"${HOME}"}
workspace="$(mktemp -d /tmp/capture8k-update.XXXXXX)"
typeset -a staged_directories installed_targets
staged_directories=()
installed_targets=()
committed=0

cleanup() {
  local index stage target
  for (( index = ${#staged_directories}; index > 0; index-- )); do
    stage=${staged_directories[index]}
    target=${installed_targets[index]}
    if (( ! committed )); then
      if [[ ! -e "${stage}/new" && -d "${target}" ]]; then
        /bin/mv "${target}" "${stage}/failed" || continue
      fi
      if [[ -d "${stage}/previous" ]]; then
        /bin/mv "${stage}/previous" "${target}" || continue
      fi
    fi
    /bin/rm -rf "${stage}"
  done
  /bin/rm -rf "${workspace}"
}
trap cleanup EXIT

archive="${workspace}/Capture8K-complet-v${version}.zip"
checksum="${archive}.sha256"
/usr/bin/curl -q -fsSL --proto '=https,file' --proto-redir '=https' --connect-timeout 10 --max-time 180 --max-filesize 67108864 -o "${archive}" "${archive_url}"
/usr/bin/curl -q -fsSL --proto '=https,file' --proto-redir '=https' --connect-timeout 10 --max-time 30 --max-filesize 4096 -o "${checksum}" "${checksum_url}"
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
read_manifest() {
  /usr/bin/plutil -extract "$2" raw -o - "$1/manifest.json" 2>/dev/null
}
[[ "$(read_manifest "${source_chrome}" name)" == Capture8K &&
   "$(read_manifest "${source_firefox}" browser_specific_settings.gecko.id)" == capture8k@coraubanne ]] ||
  { print -u2 "Extension invalide"; exit 25; }
for extension in "${source_chrome}" "${source_firefox}"; do
  [[ "$(read_manifest "${extension}" version)" == "${version}" ]] || { print -u2 "Version extension invalide"; exit 26; }
done
bridge_id=fr.clipflow.premiere.bridge
bridge_version="$(read_manifest "${source_bridge}" version)"
[[ "$(read_manifest "${source_bridge}" id)" == "$bridge_id" &&
   "$bridge_version" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || { print -u2 "Creator Bridge invalide"; exit 27; }

replace_directory() {
  local source=$1
  local target=$2
  local stage
  [[ ! -L "${target}" ]] || return 1
  /bin/mkdir -p "${target:h}"
  stage="$(mktemp -d "${3:-${target:h}}/.capture8k-update.XXXXXX")"
  staged_directories+=("${stage}")
  installed_targets+=("${target}")
  /bin/mkdir "${stage}/new"
  /usr/bin/ditto "${source}" "${stage}/new"
  if [[ -d "${target}" ]]; then
    /bin/mv "${target}" "${stage}/previous"
  fi
  /bin/mv "${stage}/new" "${target}"
}

user_documents="${install_home}/Documents/Capture8K"
typeset -aU chrome_targets
chrome_targets=()
while IFS= read -r target; do
  [[ -n "${target}" && -d "${target}" ]] || continue
  if [[ "$(read_manifest "${target}" name)" == Capture8K ]]; then
    chrome_targets+=("${target}")
  fi
done <<< "${CAPTURE8K_CHROME_TARGETS:-}"
if (( ! ${#chrome_targets} )); then chrome_targets=("${user_documents}/Chrome"); fi
for target in "${chrome_targets[@]}"; do
  replace_directory "${source_chrome}" "${target}"
done
replace_directory "${source_firefox}" "${user_documents}/Firefox"

replace_directory "${source_app}/Contents" "${app_target}/Contents" "${app_target:h}"
/usr/bin/codesign --verify --deep --strict "${app_target}"
/bin/zsh "${app_target}/Contents/Resources/creator-bridge-update.sh" install-local "${source_bridge}" "${install_home}" >/dev/null
committed=1

print '{"ok":true,"installed":true}'
