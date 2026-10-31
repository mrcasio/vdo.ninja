#!/usr/bin/env python3
"""Create server-only Test/Staging/Production room policy and access list.

Run once against the original single-room access files. Never prints secrets.
"""

import hashlib
import json
import os
import secrets
import string
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.parse import urlparse

from room_wire_id import default_password, wire_room_id, wire_stream_suffix

BASE = 'https://video.easy-cube.de/'
SOURCE = Path(os.environ.get('VDO_SECRETS_DIR', '/var/lib/apps/vdo-ninja/secrets'))
FRONTEND_INDEX = Path(os.environ.get('VDO_FRONTEND_INDEX', '/var/lib/apps/vdo-ninja/src/index.html'))
EXPECTED = ['Host', 'Creator01', 'Creator02'] + [f'Guest{i:02d}' for i in range(1, 13)]
ALPHABET = string.ascii_letters + string.digits


def unique_id(used):
    while True:
        value = ''.join(secrets.choice(ALPHABET) for _ in range(25))
        if value not in used:
            used.add(value)
            return value


def link(params, turn_key):
    return BASE + '?' + urlencode(params) + '#?turn=twilio&turnkey=' + turn_key


def parse_access_list(text):
    passwords = {}
    current = None
    for line in text.splitlines():
        if line.startswith('[') and line.endswith(']'):
            current = line[1:-1]
        elif current and line.startswith('Passwort: '):
            passwords[current] = line[len('Passwort: '):]
    return passwords


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-three-rooms.py OUTPUT_DIRECTORY')
    output = Path(sys.argv[1])
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.umask(0o077)

    policy = json.loads((SOURCE / 'access-policy.json').read_text())
    if policy.get('version') != 1 or 'rooms' in policy or set(policy['accounts']) != set(EXPECTED + ['OBS', 'Production']):
        raise RuntimeError('Expected the existing 17-account policy; refusing to overwrite a newer configuration')
    if policy['accounts']['OBS'].get('pushStream') != policy['returnStream']:
        raise RuntimeError('Existing OBS return stream does not match the policy')
    hashes = json.loads((SOURCE / 'auth-password-hashes.json').read_text())
    turn_hashes = json.loads((SOURCE / 'turn-key-hashes.json').read_text())
    passwords = parse_access_list((SOURCE / 'access-credentials.txt').read_text())
    raw_turn = dict(line.split(maxsplit=1) for line in (SOURCE / 'turn-keys.txt').read_text().splitlines())
    if set(passwords) != set(policy['accounts']) or set(raw_turn) != set(policy['accounts']) or set(hashes['accounts']) != set(policy['accounts']):
        raise RuntimeError('Existing accounts, passwords, and TURN keys do not agree')

    used = {policy['returnStream']}
    used.update(item['pushStream'] for item in policy['accounts'].values() if 'pushStream' in item)
    rooms = {
        'test': {'id': 'Test' + secrets.token_hex(10), 'returnStream': unique_id(used)},
        'staging': {'id': 'Staging' + secrets.token_hex(9), 'returnStream': unique_id(used)},
        'production': {'id': 'Production' + secrets.token_hex(8), 'returnStream': policy['returnStream']},
    }
    password = default_password(FRONTEND_INDEX)
    hostname = urlparse(BASE).hostname
    for room in rooms.values():
        room['wireId'] = wire_room_id(room['id'], password, hostname)
    policy['wireStreamSuffix'] = wire_stream_suffix(password, hostname)
    accounts = policy['accounts']
    for username in EXPECTED + ['OBS']:
        accounts[username]['room'] = 'production'
        if username != 'OBS':
            accounts[username]['label'] = username.replace('Creator', 'Creator ').replace('Guest', 'Guest ')

    for environment in ('test', 'staging'):
        prefix = environment.title()
        for slot in EXPECTED + ['OBS']:
            username = prefix + slot
            role = 'obs' if slot == 'OBS' else ('guest' if slot.startswith('Guest') else 'participant')
            account = {'role': role, 'room': environment}
            if role != 'obs':
                account['pushStream'] = unique_id(used)
                account['label'] = slot.replace('Creator', 'Creator ').replace('Guest', 'Guest ')
            else:
                account['pushStream'] = rooms[environment]['returnStream']
            accounts[username] = account
            password = secrets.token_urlsafe(18)
            salt = secrets.token_bytes(16)
            hashes['accounts'][username] = {
                'salt': salt.hex(),
                'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 310000).hex(),
                'iterations': 310000,
            }
            passwords[username] = password
            key = secrets.token_hex(32)
            raw_turn[username] = key
            turn_hashes['keys'].append({'label': username, 'sha256': hashlib.sha256(key.encode('ascii')).hexdigest()})

    policy['version'] = 2
    policy['rooms'] = rooms
    policy.pop('returnStream')
    assert len(accounts) == 49 and len(turn_hashes['keys']) == 49

    lines = [
        'VDO.Ninja-Zugaenge fuer Test, Staging und Production — vertraulich; nicht in Git speichern.',
        'Website: ' + BASE,
        'Nur Production darf Raeume als Direktor steuern oder neue Links anlegen.',
        'Gaeste, Host und Creator nutzen ausschliesslich ihre persoenlichen Links.',
        'Links enthalten TURN-Zugangsschluessel im URL-Fragment.',
        '',
        '[Production]', 'Benutzer: Production', 'Passwort: ' + passwords['Production'],
        'Studio-Zugang: ' + BASE + '#?turn=twilio&turnkey=' + raw_turn['Production'],
    ]
    for environment in ('test', 'staging', 'production'):
        lines.append('Direktor ' + environment.title() + ': ' + link(
            [('director', rooms[environment]['id'])], raw_turn['Production']))
    lines.append('')

    for environment in ('test', 'staging', 'production'):
        title = environment.title()
        room = rooms[environment]
        lines += ['=' * 12 + ' ' + title + ' ' + '=' * 12, '']
        for slot in EXPECTED + ['OBS']:
            username = slot if environment == 'production' else title + slot
            account = accounts[username]
            lines += ['[' + username + ']', 'Benutzer: ' + username, 'Passwort: ' + passwords[username]]
            if slot == 'OBS':
                lines.append('Rueckkanal-Quelle: ' + link(
                    [('room', room['id']), ('push', room['returnStream']), ('view', '')], raw_turn[username]))
                for participant in EXPECTED:
                    member = participant if environment == 'production' else title + participant
                    lines.append(participant + ' Solo-Quelle: ' + link(
                        [('room', room['id']), ('view', accounts[member]['pushStream']), ('solo', '')], raw_turn[username]))
            else:
                lines.append('Kamera-und-Rueckkanal-Link: ' + link(
                    [('room', room['id']), ('push', account['pushStream']),
                     ('view', room['returnStream']), ('label', account['label'])], raw_turn[username]))
            lines.append('')

    files = {
        'access-policy.json': json.dumps(policy, separators=(',', ':')) + '\n',
        'auth-password-hashes.json': json.dumps(hashes, separators=(',', ':')) + '\n',
        'turn-key-hashes.json': json.dumps(turn_hashes, separators=(',', ':')) + '\n',
        'turn-keys.txt': ''.join(f'{name} {key}\n' for name, key in raw_turn.items()),
        'access-credentials.txt': '\n'.join(lines) + '\n',
    }
    for name, content in files.items():
        with (output / name).open('x') as handle:
            handle.write(content)
    print('Prepared three rooms, 49 distinct accounts, and 49 TURN keys in the protected staging directory.')


if __name__ == '__main__':
    main()
