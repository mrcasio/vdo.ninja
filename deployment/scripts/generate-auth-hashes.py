#!/usr/bin/env python3
"""Create broker password hashes from the protected existing access list."""

import hashlib
import json
import os
from pathlib import Path


root = Path('/var/lib/apps/vdo-ninja')
text = (root / 'secrets/access-credentials.txt').read_text()
policy = json.loads((root / 'secrets/access-policy.json').read_text())
output = root / 'secrets/auth-password-hashes.json'
passwords = {}
label = None
for line in text.splitlines():
    if line.startswith('[') and line.endswith(']'):
        label = line[1:-1]
    elif line.startswith('Passwort: ') and label:
        passwords[label] = line.removeprefix('Passwort: ')

assert set(passwords) == set(policy['accounts'])
accounts = {}
for username, password in passwords.items():
    salt = os.urandom(16)
    accounts[username] = {
        'salt': salt.hex(),
        'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 310000).hex(),
        'iterations': 310000,
    }

descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o400)
try:
    with os.fdopen(descriptor, 'w') as handle:
        json.dump({'version': 1, 'accounts': accounts}, handle, separators=(',', ':'))
    os.chown(output, 10001, 10001)
except BaseException:
    output.unlink(missing_ok=True)
    raise
print(f'Prepared password hashes for {len(accounts)} existing accounts.')
