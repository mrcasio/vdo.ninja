#!/usr/bin/env python3
"""Prepare 45 private, password-free OBS links without printing their tokens."""

import json
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit


BASE = 'https://video.easy-cube.de'
SOURCE = Path(os.environ.get('VDO_SECRETS_DIR', '/var/lib/apps/vdo-ninja/secrets'))
SLOTS = ['Host', 'Creator01', 'Creator02'] + [f'JokerC{cohort}_{i:02d}' for cohort in (1, 2) for i in range(1, 7)]
OBS_ROOMS = {'TestOBS': ('test', 'Test'), 'StagingOBS': ('staging', 'Staging'),
             'OBS': ('production', '')}


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-obs-viewers.py OUTPUT_DIRECTORY')
    output = Path(sys.argv[1])
    os.umask(0o077)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)

    policy = json.loads((SOURCE / 'access-policy.json').read_text())
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != {'test', 'staging', 'production'}:
        raise RuntimeError('Expected the current three-room policy')
    turn_keys = dict(line.split(maxsplit=1) for line in
                     (SOURCE / 'turn-keys.txt').read_text().splitlines())
    original = (SOURCE / 'access-credentials.txt').read_text()
    if 'Solo-Quelle (ohne Login):' in original:
        raise RuntimeError('OBS viewer links already exist')

    current = None
    found = set()
    links = {}
    updated = []
    for line in original.splitlines(keepends=True):
        if re.fullmatch(r'\[[A-Za-z0-9_]+\]\n', line):
            current = line[1:-2]
        match = re.fullmatch(r'([A-Za-z0-9_]+) Solo-Quelle: (https://[^\n]+)\n', line)
        if not match or current not in OBS_ROOMS:
            updated.append(line)
            continue
        slot, old_link = match.groups()
        if slot not in SLOTS or (current, slot) in found:
            raise RuntimeError(f'Unexpected OBS source for {current}')
        found.add((current, slot))
        room_name, prefix = OBS_ROOMS[current]
        participant = prefix + slot
        account = policy['accounts'][participant]
        room = policy['rooms'][room_name]
        if (account.get('room') != room_name or
                account.get('role') not in ('participant', 'creator', 'guest') or
                policy['accounts'][current].get('role') != 'obs'):
            raise RuntimeError(f'Policy mismatch for {participant}')
        parsed = urlsplit(old_link)
        query = parse_qsl(parsed.query, keep_blank_values=True)
        fragment = dict(parse_qsl(parsed.fragment.lstrip('?'), keep_blank_values=True))
        if (parsed.scheme != 'https' or parsed.netloc != 'video.easy-cube.de' or
                parsed.path != '/' or dict(query) != {
                    'room': room['id'], 'view': account['pushStream'], 'solo': ''} or
                len(query) != 3 or fragment != {
                    'turn': 'twilio', 'turnkey': turn_keys[current]}):
            raise RuntimeError(f'Existing OBS link mismatch for {participant}')
        token = secrets.token_urlsafe(24)
        while token in links:
            token = secrets.token_urlsafe(24)
        path = '/?' + urlencode([('room', room['id']), ('view', account['pushStream']),
                                 ('solo', ''), ('obstoken', token)]) + \
            '#?turn=twilio&turnkey=' + turn_keys[current]
        links[token] = {'participant': participant, 'path': path}
        updated.append(f'{slot} Solo-Quelle (ohne Login): {BASE}/obs/{token}\n')

    if found != {(obs, slot) for obs in OBS_ROOMS for slot in SLOTS} or len(links) != 45:
        raise RuntimeError('Expected exactly 45 OBS sources')
    (output / 'obs-viewers.json').write_text(
        json.dumps({'version': 1, 'links': links}, separators=(',', ':')) + '\n')
    (output / 'access-credentials.txt').write_text(''.join(updated))
    print('Prepared 45 password-free OBS links in three rooms; no tokens printed.')


if __name__ == '__main__':
    main()
