#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
archive=${1:-"$root/source.tar.gz"}
logo=${SHOW_LOGO:-"$root/../clients/projects/control/public/WWI_Freigestellt.png"}
favicon=${SHOW_FAVICON:-"$root/../clients/projects/control/public/favicon.ico"}
expected=4f1efffe29e043393cddd6b26b03c5a5c641e5e5d24a2050c3b99ac0f37a34d2

[[ -f "$archive" ]] || { echo "Missing upstream archive: $archive" >&2; exit 1; }
[[ -f "$logo" ]] || { echo "Missing show logo: $logo" >&2; exit 1; }
[[ -f "$favicon" ]] || { echo "Missing show favicon: $favicon" >&2; exit 1; }
[[ ! -e "$root/src" ]] || { echo "src already exists; move it aside before preparing a fresh copy" >&2; exit 1; }
actual=$(openssl dgst -sha256 "$archive" | awk '{print $NF}')
[[ "$actual" == "$expected" ]] || { echo "Upstream archive checksum mismatch" >&2; exit 1; }

prepared=$(mktemp -d "$root/.source-prep.XXXXXX")
trap 'rm -rf -- "$prepared"' EXIT
tar -xzf "$archive" -C "$prepared" --strip-components=1
patch -s -d "$prepared" -p1 < "$root/patches/index.patch"
patch -s -d "$prepared" -p1 < "$root/patches/main.patch"
patch -s -d "$prepared" -p1 < "$root/patches/lib.patch"
patch -s -d "$prepared" -p1 < "$root/patches/obs-view.patch"
cp "$root/overrides/access-denied.html" "$prepared/access-denied.html"
cp "$root/overrides/show-theme.css" "$prepared/show-theme.css"
cp "$root/overrides/manifest.json" "$prepared/manifest.json"
cp "$logo" "$prepared/media/show-logo.png"
cp "$favicon" "$prepared/favicon.ico"
mkdir -p "$prepared/source/signaling"
cp "$root/signaling/"{Dockerfile,LICENSE,README.txt,index.html,package.json,package-lock.json,vdoninja_advanced.js} "$prepared/source/signaling/"
mv "$prepared" "$root/src"
trap - EXIT
echo 'Prepared pinned VDO.Ninja frontend with show branding.'
