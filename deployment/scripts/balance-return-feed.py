#!/usr/bin/env python3
"""Stage balanced 1080p30/3000-kbit/s return links from the current v4 files.

The source files remain untouched. Passwords, stream IDs, TURN fragments, and
all existing shortlink tokens are preserved.
"""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit


ROOMS = ('test', 'staging', 'production')
OLD_PUBLISHER_SUFFIX = ('&totalroombitrate=2000&outboundvideobitrate=2000'
                        '&roombitrate=2000&contenthint=detail')
NEW_PUBLISHER_SUFFIX = ('&totalroombitrate=3000&outboundvideobitrate=3000'
                        '&roombitrate=3000&quality=0&maxframerate=30')
HEADING = re.compile(r'\[([A-Za-z0-9_]+)\]\n')


def parse_link(link, username, turn_keys):
    url = urlsplit(link)
    if url.scheme not in ('', 'https') or url.netloc not in ('', 'video.easy-cube.de') or \
            url.path != '/' or not url.fragment:
        raise ValueError('Unexpected private link shape')
    query_pairs = parse_qsl(url.query, keep_blank_values=True)
    fragment_pairs = parse_qsl(url.fragment.lstrip('?'), keep_blank_values=True)
    query = dict(query_pairs)
    fragment = dict(fragment_pairs)
    if len(query_pairs) != len(query) or len(fragment_pairs) != len(fragment) or \
            fragment.get('turn') != 'twilio' or \
            fragment.get('turnkey') != turn_keys[username]:
        raise ValueError('Unexpected query or TURN fragment')
    if username == 'Production' or username.endswith('Director'):
        if set(fragment) != {'codirector', 'turn', 'turnkey'} or \
                not re.fullmatch(r'[A-Za-z0-9]{28}', fragment['codirector']):
            raise ValueError('Director fragment differs from v4')
    elif set(fragment) != {'turn', 'turnkey'}:
        raise ValueError('Participant fragment differs from v4')
    return url, query


def updated_link(link, username, policy, turn_keys, room_name=None):
    url, query = parse_link(link, username, turn_keys)
    if username == 'Production':
        room = policy['rooms'][room_name]
        if query != {'director': room['id'], 'nopush': '',
                     'totalroombitrate': '2000'} or \
                url.query.count('totalroombitrate=2000') != 1:
            raise ValueError('Production main link differs from current policy')
        new_query = url.query.replace('totalroombitrate=2000',
                                      'totalroombitrate=3000', 1)
    else:
        account = policy['accounts'][username]
        room = policy['rooms'][account['room']]
        if account['role'] == 'codirector':
            if query != {
                'director': room['id'], 'noclaim': '', 'push': room['returnStream'],
                'autogain': '0', 'echocancellation': '0', 'denoise': '0',
                'totalroombitrate': '2000', 'outboundvideobitrate': '2000',
                'roombitrate': '2000', 'contenthint': 'detail'
            } or url.query.count(OLD_PUBLISHER_SUFFIX) != 1:
                raise ValueError('Co-director link differs from current policy')
            new_query = url.query.replace(OLD_PUBLISHER_SUFFIX,
                                          NEW_PUBLISHER_SUFFIX, 1)
        elif account['role'] in ('participant', 'creator', 'guest'):
            expected = {
                'room': room['id'], 'push': account['pushStream'],
                'label': account['label'], 'broadcast': room['returnStream'],
                'audiogain': '0', 'totalroombitrate': '2000'
            }
            if account['role'] == 'guest':
                expected['nomicbutton'] = ''
            if query != expected or url.query.count('&totalroombitrate=2000') != 1:
                raise ValueError('Participant link differs from current policy')
            new_query = url.query.replace('&totalroombitrate=2000',
                                          '&totalroombitrate=3000', 1)
        else:
            raise ValueError('Unexpected shortlink role')
    return urlunsplit(url._replace(query=new_query))


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
            set(turn_keys) != set(policy['accounts']):
        raise ValueError('Expected the current v4 three-room configuration')

    links = {}
    old_by_user = {}
    counts = {'codirector': 0, 'participant': 0}
    for token, entry in mapping['links'].items():
        username = entry.get('username')
        if not re.fullmatch(r'[A-Za-z0-9_-]{22}', token) or \
                username not in policy['accounts'] or username in old_by_user or \
                not isinstance(entry.get('path'), str) or \
                not entry['path'].startswith('/?'):
            raise ValueError('Unexpected shortlink entry')
        role = policy['accounts'][username]['role']
        counts['codirector' if role == 'codirector' else 'participant'] += 1
        links[token] = {**entry, 'path': updated_link(
            entry['path'], username, policy, turn_keys)}
        old_by_user[username] = entry['path']
    if counts != {'codirector': 3, 'participant': 45}:
        raise ValueError('Unexpected shortlink account counts')

    current = None
    changed_accounts = set()
    changed_production = set()
    result = []
    for line in access.splitlines(keepends=True):
        heading = HEADING.fullmatch(line)
        if heading:
            current = heading.group(1)
        if current == 'Production' and line.startswith('Haupt-Director '):
            label, old_url = line.rstrip('\n').split(': ', 1)
            name = label.removeprefix('Haupt-Director ').lower()
            if name not in ROOMS or name in changed_production:
                raise ValueError('Unexpected Production link')
            line = label + ': ' + updated_link(
                old_url, 'Production', policy, turn_keys, name) + '\n'
            changed_production.add(name)
        elif current in old_by_user and line.startswith((
                'Co-Director-und-Rueckkanal-Link: ',
                'Kamera-und-Rueckkanal-Link: ')):
            if current in changed_accounts:
                raise ValueError('Duplicate account link')
            label, old_url = line.rstrip('\n').split(': ', 1)
            if urlsplit(old_url).query != urlsplit(old_by_user[current]).query:
                raise ValueError('Access-list link differs from shortlink map')
            line = label + ': ' + updated_link(
                old_url, current, policy, turn_keys) + '\n'
            changed_accounts.add(current)
        result.append(line)
    if changed_accounts != set(old_by_user) or changed_production != set(ROOMS):
        raise ValueError('Access list is incomplete')

    output.mkdir(mode=0o700, parents=False)
    try:
        files = {
            'shortlinks.json': (json.dumps({**mapping, 'links': links},
                                           separators=(',', ':')) + '\n', 0o400),
            'access-credentials.txt': (''.join(result), 0o600),
        }
        for name, (content, mode) in files.items():
            target = output / name
            target.write_text(content)
            target.chmod(mode)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged 3 main links, 3 balanced return publishers and 45 room viewers; '
          'all accounts and tokens preserved.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: balance-return-feed.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
