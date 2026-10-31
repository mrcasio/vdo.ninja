#!/usr/bin/env python3
"""Stage a checked, secret-preserving Guest-to-Joker migration for three rooms."""

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

FILES = (
    'access-policy.json', 'auth-password-hashes.json', 'turn-key-hashes.json',
    'turn-keys.txt', 'shortlinks.json', 'obs-viewers.json',
    'access-credentials.txt',
)
ROOM_PREFIXES = ('Test', 'Staging', '')
OLD_NAMES = {
    prefix + f'Guest{number:02d}':
    prefix + f'JokerC{1 if number <= 6 else 2}_{(number - 1) % 6 + 1:02d}'
    for prefix in ROOM_PREFIXES for number in range(1, 13)
}
SLOT_LABELS = {
    f'Guest {number:02d}': f'JokerC{1 if number <= 6 else 2}_{(number - 1) % 6 + 1:02d}'
    for number in range(1, 13)
}
USERNAME_RE = re.compile(r'(?<![A-Za-z0-9_])(?:Test|Staging)?Guest(?:0[1-9]|1[0-2])(?![A-Za-z0-9_])')
URL_LABEL_RE = re.compile(r'(?<=[?&])label=Guest\+(0[1-9]|1[0-2])(?=&|#|$)')


def renamed(name):
    return OLD_NAMES.get(name, name)


def replace_url_label(path):
    matches = list(URL_LABEL_RE.finditer(path))
    if len(matches) != 1:
        raise ValueError('Expected exactly one Guest label in an invitation URL')
    return URL_LABEL_RE.sub(lambda m: 'label=' + SLOT_LABELS['Guest ' + m[1]], path)


def main(source, destination):
    os.umask(0o077)
    if destination.exists():
        raise FileExistsError(destination)
    old_bytes = {name: (source / name).read_bytes() for name in FILES}
    old = {name: json.loads(old_bytes[name]) for name in FILES if name.endswith('.json')}
    policy = old['access-policy.json']
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != {'test', 'staging', 'production'}:
        raise ValueError('Expected the current three-room policy')
    accounts = policy['accounts']
    if len(accounts) != 52 or not set(OLD_NAMES).issubset(accounts):
        raise ValueError('Expected all 36 legacy Guest accounts')
    if len(set(OLD_NAMES.values())) != 36 or set(OLD_NAMES.values()) & set(accounts):
        raise ValueError('Joker names conflict with existing accounts')
    for old_name, new_name in OLD_NAMES.items():
        room = 'test' if old_name.startswith('Test') else 'staging' if old_name.startswith('Staging') else 'production'
        number = int(old_name[-2:])
        if accounts[old_name].get('role') != 'guest' or accounts[old_name].get('room') != room or accounts[old_name].get('label') != f'Guest {number:02d}':
            raise ValueError('Unexpected legacy Guest account')

    changed = {}
    new_policy = dict(policy)
    new_policy['accounts'] = {}
    for name, account in accounts.items():
        item = dict(account)
        if name in OLD_NAMES:
            item['label'] = SLOT_LABELS[account['label']]
        new_policy['accounts'][renamed(name)] = item
    changed['access-policy.json'] = new_policy

    hashes = old['auth-password-hashes.json']
    if set(hashes['accounts']) != set(accounts):
        raise ValueError('Password hash accounts differ from policy')
    new_hashes = dict(hashes)
    new_hashes['accounts'] = {renamed(name): value for name, value in hashes['accounts'].items()}
    changed['auth-password-hashes.json'] = new_hashes

    turn_hashes = old['turn-key-hashes.json']
    if {item['label'] for item in turn_hashes['keys']} != set(accounts):
        raise ValueError('TURN hash accounts differ from policy')
    new_turn_hashes = dict(turn_hashes)
    new_turn_hashes['keys'] = [{**item, 'label': renamed(item['label'])} for item in turn_hashes['keys']]
    changed['turn-key-hashes.json'] = new_turn_hashes

    turn_lines = old_bytes['turn-keys.txt'].decode().splitlines(keepends=True)
    old_turn = dict(line.rstrip('\n').split(maxsplit=1) for line in turn_lines)
    if set(old_turn) != set(accounts) or len(turn_lines) != len(accounts):
        raise ValueError('TURN key accounts differ from policy')
    new_turn_text = ''.join(renamed(name) + ' ' + secret + ('\n' if line.endswith('\n') else '')
                            for line in turn_lines for name, secret in [line.rstrip('\n').split(maxsplit=1)])
    new_turn = dict(line.split(maxsplit=1) for line in new_turn_text.splitlines())

    shortlinks = old['shortlinks.json']
    if shortlinks.get('version') != 1 or len(shortlinks['links']) != 45:
        raise ValueError('Expected 45 personal shortlinks')
    new_shortlinks = dict(shortlinks)
    new_shortlinks['links'] = {}
    short_guest_count = 0
    for token, entry in shortlinks['links'].items():
        name = entry['username']
        if name not in accounts:
            raise ValueError('Shortlink account is missing')
        item = dict(entry)
        if name in OLD_NAMES:
            item['username'] = renamed(name)
            item['path'] = replace_url_label(entry['path'])
            before = dict(parse_qsl(urlsplit(entry['path']).query, keep_blank_values=True))
            after = dict(parse_qsl(urlsplit(item['path']).query, keep_blank_values=True))
            if before.pop('label') != accounts[name]['label'] or after.pop('label') != new_policy['accounts'][renamed(name)]['label'] or before != after or urlsplit(entry['path']).fragment != urlsplit(item['path']).fragment:
                raise ValueError('Shortlink changed outside its displayed label')
            short_guest_count += 1
        new_shortlinks['links'][token] = item
    if short_guest_count != 36:
        raise ValueError('Expected 36 Guest shortlinks')
    changed['shortlinks.json'] = new_shortlinks

    obs = old['obs-viewers.json']
    if obs.get('version') != 1 or len(obs['links']) != 45:
        raise ValueError('Expected 45 OBS viewer links')
    new_obs = dict(obs)
    new_obs['links'] = {}
    obs_guest_count = 0
    for token, entry in obs['links'].items():
        name = entry['participant']
        if name not in accounts:
            raise ValueError('OBS participant is missing')
        item = dict(entry)
        if name in OLD_NAMES:
            item['participant'] = renamed(name)
            obs_guest_count += 1
        new_obs['links'][token] = item
    if obs_guest_count != 36:
        raise ValueError('Expected 36 Guest OBS viewers')
    changed['obs-viewers.json'] = new_obs

    original_access = old_bytes['access-credentials.txt'].decode()
    if len(re.findall(r'^\[(?:Test|Staging)?Guest(?:0[1-9]|1[0-2])\]$', original_access, re.M)) != 36:
        raise ValueError('Expected 36 Guest sections in access list')
    if len(re.findall(r'\bGuest(?:0[1-9]|1[0-2]) Solo-Quelle \(ohne Login\):', original_access)) != 36:
        raise ValueError('Expected 36 Guest OBS labels in access list')
    access = USERNAME_RE.sub(lambda m: renamed(m[0]), original_access)
    access = URL_LABEL_RE.sub(lambda m: 'label=' + SLOT_LABELS['Guest ' + m[1]], access)
    if USERNAME_RE.search(access) or URL_LABEL_RE.search(access):
        raise ValueError('Legacy Guest names remain in access list')
    access_passwords = {}
    current = None
    for line in access.splitlines():
        if line.startswith('[') and line.endswith(']'):
            current = line[1:-1]
        elif line.startswith('Passwort: ') and current:
            access_passwords[current] = line.removeprefix('Passwort: ')
    if set(access_passwords) != set(new_policy['accounts']):
        raise ValueError('Access list accounts differ from policy')
    for name, password in access_passwords.items():
        record = new_hashes['accounts'][name]
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(record['salt']), record['iterations']).hex()
        if actual != record['hash']:
            raise ValueError('Password hash mismatch')
    for item in new_turn_hashes['keys']:
        if hashlib.sha256(new_turn[item['label']].encode('ascii')).hexdigest() != item['sha256']:
            raise ValueError('TURN key hash mismatch')
    # Every protected token and media identifier must survive unchanged.
    for token, entry in obs['links'].items():
        if entry['path'] != new_obs['links'][token]['path']:
            raise ValueError('OBS URL changed')
    for old_name, new_name in OLD_NAMES.items():
        old_account = accounts[old_name]
        new_account = new_policy['accounts'][new_name]
        if {k: v for k, v in old_account.items() if k != 'label'} != {k: v for k, v in new_account.items() if k != 'label'}:
            raise ValueError('Media account details changed')

    destination.mkdir(mode=0o700, parents=False)
    try:
        for name in FILES:
            data = (json.dumps(changed[name], ensure_ascii=False, separators=(',', ':')) + '\n').encode() if name in changed else (new_turn_text if name == 'turn-keys.txt' else access).encode()
            path = destination / name
            path.write_bytes(data)
            path.chmod(0o400 if name.endswith('.json') else 0o600)
    except BaseException:
        for path in destination.iterdir():
            path.unlink()
        destination.rmdir()
        raise
    print('Staged 36 Joker account names and labels in three rooms; 45 personal and 45 OBS tokens preserved; all passwords and TURN keys verified.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: rename-joker-slots.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
