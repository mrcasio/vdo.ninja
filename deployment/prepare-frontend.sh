#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ ! -e src ]] || { echo "src already exists; refusing replacement" >&2; exit 1; }
mkdir src
tar -C .. --exclude=./.git --exclude=./deployment -cf - . | tar -C src -xf -
