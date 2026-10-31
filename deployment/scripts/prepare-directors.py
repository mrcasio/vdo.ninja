#!/usr/bin/env python3
"""Prepare three room-bound directors and Production co-director links.

Reads the existing private secrets and writes a new private set to OUTPUT_DIRECTORY.
Never writes secrets to stdout or the project repository.
"""

import hashlib
import json
import os
import re
import secrets
import string
import sys
from pathlib import Path
from urllib.parse import urlencode


BASE = 'https://video.easy-cube.de/'
SOURCE = Path(os.environ.get('VDO_SECRETS_DIR', '/var/lib/apps/vdo-ninja/secrets'))
ROOMS = ('test', 'staging', 'production')
ALPHABET = string.ascii_letters + string.digits


def random_text(length):
    return ''.join(secrets.choice(ALPHABET) for _ in range(length))


def personal_link(params, director_code, turn_key):
    query = urlencode(params)
    fragment = urlencode((('codirector', director_code), ('turn', 'twilio'), ('turnkey', turn_key)))
    return BASE + '?' + query + '#?' + fragment


def passwords_in(text):
    passwords = {}
    current = None
    for line in text.splitlines():
        if line.startswith('[') and line.endswith(']'):
            current = line[1:-1]
        elif current and line.startswith('Passwort: '):
            passwords[current] = line.removeprefix('Passwort: ')
    return passwords


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-directors.py OUTPUT_DIRECTORY')
    os.umask(0o077)
    output = Path(sys.argv[1])
    output.mkdir(mode=0o700, parents=False, exist_ok=False)

    policy = json.loads((SOURCE / 'access-policy.json').read_text())
    hashes = json.loads((SOURCE / 'auth-password-hashes.json').read_text())
    turn_hashes = json.loads((SOURCE / 'turn-key-hashes.json').read_text())
    access_text = (SOURCE / 'access-credentials.txt').read_text()
    passwords = passwords_in(access_text)
    raw_turn = dict(line.split(maxsplit=1) for line in (SOURCE / 'turn-keys.txt').read_text().splitlines())
    if (policy.get('version') != 2 or set(policy.get('rooms', {})) != set(ROOMS) or
            len(policy['accounts']) != 49 or policy['accounts'].get('Production', {}).get('role') != 'production' or
            set(policy['accounts']) != set(passwords) or
            set(policy['accounts']) != set(hashes['accounts']) or
            set(policy['accounts']) != set(raw_turn) or
            len(turn_hashes['keys']) != 49):
        raise RuntimeError('Expected the existing 49-account, three-room configuration')

    director_codes = {name: random_text(28) for name in ROOMS}
    accounts = policy['accounts']
    accounts['Production']['role'] = 'codirector'
    for environment in ROOMS:
        title = environment.title()
        room = policy['rooms'][environment]
        obs = title + 'OBS' if environment != 'production' else 'OBS'
        if (accounts[obs].get('role') != 'obs' or accounts[obs].get('room') != environment or
                accounts[obs].get('pushStream') != room['returnStream']):
            raise RuntimeError('OBS return stream differs from the room policy')
        del accounts[obs]['pushStream']

        username = title + 'Director'
        if username in accounts:
            raise RuntimeError('Director account already exists')
        accounts[username] = {
            'role': 'director', 'room': environment, 'pushStream': room['returnStream'],
        }
        password = random_text(28)
        salt = secrets.token_bytes(16)
        passwords[username] = password
        hashes['accounts'][username] = {
            'salt': salt.hex(),
            'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 310000).hex(),
            'iterations': 310000,
        }
        turn_key = secrets.token_hex(32)
        raw_turn[username] = turn_key
        turn_hashes['keys'].append({
            'label': username, 'sha256': hashlib.sha256(turn_key.encode('ascii')).hexdigest(),
        })

    policy['version'] = 3
    assert len(accounts) == len(hashes['accounts']) == len(raw_turn) == len(turn_hashes['keys']) == 52

    old_note = 'Nur Production darf Raeume als Direktor steuern oder neue Links anlegen.'
    new_note = 'TestDirector, StagingDirector und ProductionDirector senden den Rueckkanal; Production ist nur Co-Director.'
    if access_text.count(old_note) != 1:
        raise RuntimeError('Unexpected access-list header')
    access_text = access_text.replace(old_note, new_note)

    production_start = access_text.index('[Production]\n')
    test_section = '============ Test ============'
    production_end = access_text.index(test_section, production_start)
    production_block = [
        '[Production]', 'Benutzer: Production', 'Passwort: ' + passwords['Production'],
    ]
    for environment in ROOMS:
        production_block.append('Co-Director ' + environment.title() + ': ' + personal_link(
            (('director', policy['rooms'][environment]['id']), ('noclaim', ''), ('nopush', '')),
            director_codes[environment], raw_turn['Production']))
    access_text = (access_text[:production_start] + '\n'.join(production_block) + '\n\n' +
                   access_text[production_end:])

    for environment in ROOMS:
        title = environment.title()
        username = title + 'Director'
        marker = '============ ' + title + ' ============\n\n'
        if access_text.count(marker) != 1:
            raise RuntimeError('Unexpected room heading')
        director_block = '\n'.join([
            '[' + username + ']', 'Benutzer: ' + username,
            'Passwort: ' + passwords[username],
            'Director-und-Rueckkanal-Link: ' + personal_link(
                (('director', policy['rooms'][environment]['id']),
                 ('push', policy['rooms'][environment]['returnStream']),
                 ('autogain', '0'), ('echocancellation', '0'),
                 ('denoise', '0'), ('totalroombitrate', '2000')),
                director_codes[environment], raw_turn[username]),
            '', '',
        ])
        access_text = access_text.replace(marker, marker + director_block, 1)

    access_text, removed = re.subn(r'^Rueckkanal-Quelle: .*\n', '', access_text, flags=re.MULTILINE)
    if removed != 3 or set(passwords_in(access_text)) != set(accounts):
        raise RuntimeError('Access-list rewrite did not preserve all accounts')

    files = {
        'access-policy.json': json.dumps(policy, separators=(',', ':')) + '\n',
        'auth-password-hashes.json': json.dumps(hashes, separators=(',', ':')) + '\n',
        'turn-key-hashes.json': json.dumps(turn_hashes, separators=(',', ':')) + '\n',
        'turn-keys.txt': ''.join(f'{name} {key}\n' for name, key in raw_turn.items()),
        'access-credentials.txt': access_text,
    }
    for name, content in files.items():
        with (output / name).open('x') as handle:
            handle.write(content)
    print('Prepared three primary Director accounts and three Production co-director links for 52 accounts.')


if __name__ == '__main__':
    main()
