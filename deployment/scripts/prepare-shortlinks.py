#!/usr/bin/env python3
"""Prepare personal shortlinks and show guest URL flags without printing secrets."""

import json
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


BASE = 'https://video.easy-cube.de'
SOURCE = Path(os.environ.get('VDO_SECRETS_DIR', '/var/lib/apps/vdo-ninja/secrets'))
LINK_LABEL = 'Kamera-und-Rueckkanal-Link: '
SHORT_LABEL = 'Kurzlink: '
ROOM_PREFIXES = {'test': 'Test', 'staging': 'Staging', 'production': ''}


def expected_accounts():
    hosts = {prefix + 'Host' for prefix in ROOM_PREFIXES.values()}
    creators = {prefix + f'Creator{number:02d}' for prefix in ROOM_PREFIXES.values()
                for number in (1, 2)}
    guests = {prefix + f'JokerC{cohort}_{number:02d}' for prefix in ROOM_PREFIXES.values()
              for cohort in (1, 2) for number in range(1, 7)}
    return hosts, creators, guests


def validate_link(name, account, rooms, turn_keys, link):
    parsed = urlsplit(link)
    if (parsed.scheme != 'https' or parsed.netloc != 'video.easy-cube.de' or
            parsed.path != '/' or not parsed.fragment):
        raise ValueError(f'Unexpected link shape for {name}')
    query = parse_qsl(parsed.query, keep_blank_values=True)
    if len(query) != 4 or {key for key, _ in query} != {'room', 'push', 'view', 'label'}:
        raise ValueError(f'Unexpected link fields for {name}')
    fields = dict(query)
    room = rooms[account['room']]
    if (fields['room'] != room['id'] or fields['push'] != account['pushStream'] or
            fields['view'] != room['returnStream'] or fields['label'] != account['label']):
        raise ValueError(f'Link differs from policy for {name}')
    fragment = parse_qsl(parsed.fragment.lstrip('?'), keep_blank_values=True)
    if len(fragment) != 2 or dict(fragment) != {
            'turn': 'twilio', 'turnkey': turn_keys[name]}:
        raise ValueError(f'TURN fragment differs from policy for {name}')
    return query, fragment


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-shortlinks.py OUTPUT_DIRECTORY')
    os.umask(0o077)
    output = Path(sys.argv[1])
    output.mkdir(mode=0o700, parents=False, exist_ok=False)

    policy = json.loads((SOURCE / 'access-policy.json').read_text())
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != set(ROOM_PREFIXES):
        raise RuntimeError('Expected the current three-room policy')
    hosts, creators, guests = expected_accounts()
    invitees = hosts | creators | guests
    accounts = policy['accounts']
    if (len(accounts) != 52 or
            {name for name, account in accounts.items()
             if account['role'] in ('participant', 'guest')} != invitees or
            any(accounts[name]['role'] != ('guest' if name in guests else 'participant')
                for name in invitees)):
        raise RuntimeError('Expected three hosts, six creators, and 36 guests')

    turn_keys = dict(line.split(maxsplit=1) for line in
                     (SOURCE / 'turn-keys.txt').read_text().splitlines())
    if set(turn_keys) != set(accounts):
        raise RuntimeError('TURN key accounts differ from policy')
    original = (SOURCE / 'access-credentials.txt').read_text()
    if SHORT_LABEL in original:
        raise RuntimeError('Access list already contains shortlinks')

    updated = []
    links = {}
    seen = set()
    current = None
    for line in original.splitlines(keepends=True):
        if re.fullmatch(r'\[[A-Za-z0-9_]+\]\n', line):
            current = line[1:-2]
        if line.startswith(LINK_LABEL) and current in invitees:
            if current in seen:
                raise RuntimeError(f'Duplicate personal link for {current}')
            seen.add(current)
            query, fragment = validate_link(current, accounts[current], policy['rooms'],
                                            turn_keys, line[len(LINK_LABEL):].rstrip('\n'))
            query_string = urlencode((key, value) for key, value in query if key != 'view') + '&broadcast&audiogain=0'
            if current in guests:
                query_string += '&nomicbutton'
            # Normalize the private fragment for shortlinks. Keep the Host long link's TURN fragment.
            long_link = urlunsplit(('https', 'video.easy-cube.de', '/', query_string,
                                     '?' + urlencode(fragment)))
            token = secrets.token_urlsafe(16)
            while token in links:
                token = secrets.token_urlsafe(16)
            links[token] = {'username': current, 'path': long_link.removeprefix(BASE)}
            if current in hosts:
                original = urlsplit(line[len(LINK_LABEL):].rstrip('\n'))
                access_link = urlunsplit((original.scheme, original.netloc, original.path,
                                          query_string, original.fragment))
            else:
                access_link = long_link
            updated.append(LINK_LABEL + access_link + '\n')
            updated.append(f'{SHORT_LABEL}{BASE}/l/{token}\n')
        else:
            updated.append(line)
    if seen != invitees or len(links) != 45:
        raise RuntimeError('Expected exactly 45 personal links')

    (output / 'shortlinks.json').write_text(
        json.dumps({'version': 1, 'links': links}, separators=(',', ':')) + '\n')
    (output / 'access-credentials.txt').write_text(''.join(updated))
    print('Prepared 45 personal shortlinks; 36 Joker links disable the local mic button.')


if __name__ == '__main__':
    main()
