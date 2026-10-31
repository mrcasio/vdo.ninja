#!/usr/bin/env bash
set -euo pipefail
umask 077

secrets=/var/lib/apps/vdo-ninja/secrets
install -d -m 0750 -o root -g 10001 "$secrets"
if [[ -e "$secrets/turn-keys.txt" || -e "$secrets/turn-key-hashes.json" ]]; then
    echo 'TURN keys already exist; refusing to replace them.' >&2
    exit 1
fi

labels=(Host Creator01 Creator02)
for n in {01..12}; do labels+=("Guest$n"); done
raw_tmp=$(mktemp "$secrets/.turn-keys.XXXXXX")
hash_tmp=$(mktemp "$secrets/.turn-hashes.XXXXXX")
trap 'rm -f "$raw_tmp" "$hash_tmp"' EXIT
printf '{"keys":[' > "$hash_tmp"
first=1
for label in "${labels[@]}"; do
    key=$(openssl rand -hex 32)
    hash=$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)
    printf '%s %s\n' "$label" "$key" >> "$raw_tmp"
    if [[ "$first" -eq 0 ]]; then printf ',' >> "$hash_tmp"; fi
    first=0
    printf '{"label":"%s","sha256":"%s"}' "$label" "$hash" >> "$hash_tmp"
done
printf ']}\n' >> "$hash_tmp"
chown root:root "$raw_tmp"
chmod 0600 "$raw_tmp"
chown 10001:10001 "$hash_tmp"
chmod 0400 "$hash_tmp"
mv "$raw_tmp" "$secrets/turn-keys.txt"
mv "$hash_tmp" "$secrets/turn-key-hashes.json"
echo 'Created 15 private TURN invite keys.'
