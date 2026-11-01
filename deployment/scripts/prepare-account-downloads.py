#!/usr/bin/env python3
"""Create a private export source from the protected access list. Never prints credentials."""
import argparse, hashlib, hmac, json, os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('secrets_directory', type=Path)
parser.add_argument('new_output_file', type=Path)
args = parser.parse_args()
policy = json.loads((args.secrets_directory / 'access-policy.json').read_text())
hashes = json.loads((args.secrets_directory / 'auth-password-hashes.json').read_text())['accounts']
passwords = {}
username = None
for line in (args.secrets_directory / 'access-credentials.txt').read_text().splitlines():
    if line.startswith('[') and line.endswith(']'):
        username = line[1:-1]
    elif line.startswith('Passwort: ') and username in policy['accounts']:
        passwords[username] = line[len('Passwort: '):]
accounts = {}
for username, password in passwords.items():
    record = hashes.get(username)
    if not record or record.get('iterations') != 310000:
        continue
    candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(record['salt']), 310000).hex()
    if not hmac.compare_digest(candidate, record['hash']):
        continue
    fingerprint = hashlib.sha256((record['salt'] + ':' + record['hash']).encode()).hexdigest()
    accounts[username] = {'password': password, 'fingerprint': fingerprint}
# This file is runtime-only. The application never exports a password after its fingerprint changes.
fd = os.open(args.new_output_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'version': 1, 'accounts': accounts}, stream)
    stream.flush()
    os.fsync(stream.fileno())
print(f'Prepared private export source: {len(accounts)} verified original passwords; no account was modified.')
