#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ! -t 0 ]]; then
    echo 'Run this script in an interactive SSH terminal.' >&2
    exit 1
fi
read -r -p 'Twilio Account SID (AC...): ' account_sid
read -r -p 'Twilio API Key SID (SK...): ' api_key_sid
read -r -s -p 'Twilio API Secret (hidden): ' api_key_secret
printf '\n'
if [[ ! "$account_sid" =~ ^AC[0-9a-fA-F]{32}$ || ! "$api_key_sid" =~ ^SK[0-9a-fA-F]{32}$ || ! "$api_key_secret" =~ ^[a-zA-Z0-9_-]{32,128}$ ]]; then
    echo 'Invalid SID or secret format; nothing was saved.' >&2
    exit 1
fi
secrets=/var/lib/apps/vdo-ninja/secrets
install -d -m 0750 -o root -g 10001 "$secrets"
tmp=$(mktemp "$secrets/.twilio.XXXXXX")
trap 'rm -f "$tmp"' EXIT
printf '{"accountSid":"%s","apiKeySid":"%s","apiKeySecret":"%s"}\n' \
    "$account_sid" "$api_key_sid" "$api_key_secret" > "$tmp"
chown 10001:10001 "$tmp"
chmod 0400 "$tmp"
mv "$tmp" "$secrets/twilio.json"
unset api_key_secret
echo 'Twilio credentials saved on the server; values were not printed.'
