#!/usr/bin/env python3
"""Stage 2000-kbit/s return-feed links from the current private v4 files.

Preserves accounts, passwords, IDs, fragments, and all shortlink tokens. The
source directory is never changed; the output directory must not exist yet.
"""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit


ORIGIN = 'https://video.easy-cube.de'
ROOMS = ('test', 'staging', 'production')
PUBLISHER_FIELDS = {
    'director', 'noclaim', 'push', 'autogain', 'echocancellation', 'denoise'
}
PARTICIPANT_FIELDS = {'room', 'push', 'label', 'broadcast', 'audiogain'}
PUBLISHER_SUFFIX = ('&totalroombitrate=2000&outboundvideobitrate=2000'
                    '&roombitrate=2000&contenthint=detail')
PARTICIPANT_SUFFIX = '&totalroombitrate=2000'
HEADING = re.compile(r'\[([A-Za-z0-9_]+)\]\n')


def parse_link(link, username, policy, turn_keys):
    url = urlsplit(link)
    if url.scheme not in ('', 'https') or url.netloc not in ('', 'video.easy-cube.de') or \
            url.path != '/' or not url.fragment:
        raise ValueError('Unexpected private link shape')
    pairs = parse_qsl(url.query, keep_blank_values=True)
    fields = dict(pairs)
    fragment_pairs = parse_qsl(url.fragment.lstrip('?'), keep_blank_values=True)
    fragment = dict(fragment_pairs)
    if len(pairs) != len(fields) or len(fragment_pairs) != len(fragment) or \
            fragment.get('turn') != 'twilio' or \
            fragment.get('turnkey') != turn_keys[username]:
        raise ValueError('Unexpected query or TURN fragment')
    account = policy['accounts'][username]
    room = policy['rooms'][account['room']]
    if account['role'] == 'codirector':
        if set(fields) != PUBLISHER_FIELDS or fields != {
            'director': room['id'], 'noclaim': '', 'push': room['returnStream'],
            'autogain': '0', 'echocancellation': '0', 'denoise': '0'
        } or set(fragment) != {'codirector', 'turn', 'turnkey'} or \
                not re.fullmatch(r'[A-Za-z0-9]{28}', fragment['codirector']):
            raise ValueError('Return publisher link differs from v4')
        return url, PUBLISHER_SUFFIX
    if account['role'] not in ('participant', 'creator', 'guest'):
        raise ValueError('Unexpected account role in shortlink map')
    expected = {
        'room': room['id'], 'push': account['pushStream'],
        'label': account['label'], 'broadcast': room['returnStream'],
        'audiogain': '0'
    }
    if account['role'] == 'guest':
        expected['nomicbutton'] = ''
    if fields != expected or set(fields) != (PARTICIPANT_FIELDS | (
            {'nomicbutton'} if account['role'] == 'guest' else set())) or \
            set(fragment) != {'turn', 'turnkey'}:
        raise ValueError('Participant link differs from v4')
    return url, PARTICIPANT_SUFFIX


def updated_link(link, username, policy, turn_keys):
    url, suffix = parse_link(link, username, policy, turn_keys)
    return urlunsplit(url._replace(query=url.query + suffix))


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
            len(policy.get('accounts', {})) != 52 or mapping.get('version') != 1 or \
            len(mapping.get('links', {})) != 48 or \
            set(turn_keys) != set(policy['accounts']):
        raise ValueError('Expected the current v4 three-room configuration')
    for name in ROOMS:
        account = policy['accounts'][name.title() + 'Director']
        if account != {'role': 'codirector', 'room': name,
                       'pushStream': policy['rooms'][name]['returnStream']}:
            raise ValueError('Unexpected room publisher policy')

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

    changed = set()
    current = None
    result = []
    for line in access.splitlines(keepends=True):
        heading = HEADING.fullmatch(line)
        if heading:
            current = heading.group(1)
        if current in old_by_user and line.startswith((
                'Co-Director-und-Rueckkanal-Link: ',
                'Kamera-und-Rueckkanal-Link: ')):
            if current in changed:
                raise ValueError('Duplicate private access-list link')
            label, old_url = line.rstrip('\n').split(': ', 1)
            if urlsplit(old_url).query != urlsplit(old_by_user[current]).query:
                raise ValueError('Access-list link differs from shortlink map')
            line = label + ': ' + updated_link(
                old_url, current, policy, turn_keys) + '\n'
            changed.add(current)
        result.append(line)
    if changed != set(old_by_user):
        raise ValueError('Access list is incomplete')

    output.mkdir(mode=0o700, parents=False)
    try:
        staged = {
            'shortlinks.json': (json.dumps({**mapping, 'links': links},
                                           separators=(',', ':')) + '\n', 0o400),
            'access-credentials.txt': (''.join(result), 0o600),
        }
        for name, (content, mode) in staged.items():
            target = output / name
            target.write_text(content)
            target.chmod(mode)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged 3 enhanced return publishers and 45 explicit 2000-kbit/s viewers; '
          'all accounts and tokens preserved.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: raise-return-feed-quality.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
