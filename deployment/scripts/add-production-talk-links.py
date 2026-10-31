#!/usr/bin/env python3
"""Stage three microphone-only Production links without changing credentials.

Reads the current private v4 files and writes a new v5 policy, shortlink map,
and access list to a protected directory. Never prints private IDs or keys.
"""

import json
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import quote


BASE = 'https://video.easy-cube.de'
ROOMS = ('test', 'staging', 'production')


def query(pairs):
    return '&'.join(quote(key, safe='') if value == '' else
                    quote(key, safe='') + '=' + quote(value, safe='')
                    for key, value in pairs)


def main(source, output):
    os.umask(0o077)
    if output.exists():
        raise FileExistsError(output)
    policy = json.loads((source / 'access-policy.json').read_text())
    mapping = json.loads((source / 'shortlinks.json').read_text())
    access = (source / 'access-credentials.txt').read_text()
    turn_keys = dict(line.split(maxsplit=1) for line in
                     (source / 'turn-keys.txt').read_text().splitlines())
    if policy.get('version') != 4 or set(policy.get('rooms', {})) != set(ROOMS) or \
            len(policy.get('accounts', {})) != 52 or \
            policy['accounts'].get('Production') != {
                'role': 'director', 'rooms': list(ROOMS)} or \
            mapping.get('version') != 1 or len(mapping.get('links', {})) != 48 or \
            set(turn_keys) != set(policy['accounts']) or \
            not re.fullmatch(r'[0-9a-f]{64}', turn_keys['Production']):
        raise ValueError('Expected the current v4 three-room configuration')
    if access.count('[Production]\n') != 1 or 'Production-Talk ' in access:
        raise ValueError('Production access section differs from the expected layout')
    for name in ROOMS:
        room = policy['rooms'][name]
        if 'talkStream' in room or not room.get('id') or not room.get('returnStream') or \
                access.count('Haupt-Director ' + name.title() + ': ') != 1:
            raise ValueError('Room or Production link differs from the expected layout')

    used_streams = {room['returnStream'] for room in policy['rooms'].values()}
    used_streams.update(account['pushStream'] for account in policy['accounts'].values()
                        if account.get('pushStream'))
    links = dict(mapping['links'])
    inserted = []
    for name in ROOMS:
        room = policy['rooms'][name]
        talk_stream = 'ProdTalk' + secrets.token_hex(12)
        while talk_stream in used_streams:
            talk_stream = 'ProdTalk' + secrets.token_hex(12)
        used_streams.add(talk_stream)
        room['talkStream'] = talk_stream
        long_link = BASE + '/?' + query((
            ('room', room['id']), ('push', talk_stream),
            ('label', 'production-talk'), ('broadcast', room['returnStream']),
            ('totalroombitrate', '3000'), ('miconly', ''),
            ('audiogain', '0')))
        long_link += '#?turn=twilio&turnkey=' + turn_keys['Production']
        token = secrets.token_urlsafe(16)
        while token in links:
            token = secrets.token_urlsafe(16)
        links[token] = {'username': 'Production', 'path': long_link.removeprefix(BASE)}
        title = name.title()
        inserted.append('Production-Talk ' + title + ': ' + long_link + '\n')
        inserted.append('Production-Talk-Kurzlink ' + title + ': ' +
                        BASE + '/l/' + token + '\n')

    lines = access.splitlines(keepends=True)
    anchor = 'Haupt-Director Production: '
    position = next(index for index, line in enumerate(lines)
                    if line.startswith(anchor))
    lines[position + 1:position + 1] = inserted
    if len(links) != 51 or len(inserted) != 6:
        raise ValueError('Incomplete Production talk links')
    policy['version'] = 5

    output.mkdir(mode=0o700, parents=False)
    try:
        staged = {
            'access-policy.json': (json.dumps(policy, separators=(',', ':')) + '\n', 0o400),
            'shortlinks.json': (json.dumps({**mapping, 'links': links},
                                           separators=(',', ':')) + '\n', 0o400),
            'access-credentials.txt': (''.join(lines), 0o600),
        }
        for filename, (content, mode) in staged.items():
            target = output / filename
            target.write_text(content)
            target.chmod(mode)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged three Production talk streams and three shortlinks; '
          '52 accounts and all existing links preserved.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: add-production-talk-links.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
