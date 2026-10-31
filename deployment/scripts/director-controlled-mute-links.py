#!/usr/bin/env python3
"""Stage Director-controlled mute URLs while preserving all existing shortlink tokens."""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


BASE = 'https://video.easy-cube.de'
LINK_LABEL = 'Kamera-und-Rueckkanal-Link: '


def revise(url, account, room):
    parsed = urlsplit(url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    fields = dict(pairs)
    is_host = account['role'] == 'participant' and re.fullmatch(r'(?:Test|Staging)?Host', account['name'])
    expected = {'room': room['id'], 'push': account['pushStream'],
                'label': account['label'], 'broadcast': ''}
    if not is_host:
        expected.update({'mute': '', 'audiogain': '100'})
    if (parsed.path != '/' or not parsed.fragment or len(pairs) != len(expected) or
            fields != expected or parsed.scheme not in ('', 'https') or
            parsed.netloc not in ('', 'video.easy-cube.de')):
        raise ValueError('Personal URL does not match current room and audio policy')
    new_pairs = [(key, value) for key, value in pairs if key not in ('mute', 'audiogain')]
    new_pairs.append(('audiogain', '0'))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                       urlencode(new_pairs), parsed.fragment))


def main(source, output):
    os.umask(0o077)
    if output.exists():
        raise FileExistsError(output)
    policy = json.loads((source / 'access-policy.json').read_text())
    original = json.loads((source / 'shortlinks.json').read_text())
    access = (source / 'access-credentials.txt').read_text()
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != {'test', 'staging', 'production'}:
        raise ValueError('Expected current three-room policy')
    if original.get('version') != 1 or len(original.get('links', {})) != 45:
        raise ValueError('Expected 45 personal shortlinks')

    updated = {}
    by_user = {}
    hostnames = set()
    for token, entry in original['links'].items():
        username = entry['username']
        account = policy['accounts'].get(username)
        if (not re.fullmatch(r'[A-Za-z0-9_-]{22}', token) or not account or
                username in by_user or account['role'] not in ('participant', 'creator', 'guest')):
            raise ValueError('Unexpected shortlink account or token')
        account = {**account, 'name': username}
        room = policy['rooms'][account['room']]
        old_path = entry['path']
        if not old_path.startswith('/?'):
            raise ValueError('Unexpected shortlink path')
        new_path = revise(old_path, account, room)
        updated[token] = {**entry, 'path': new_path}
        by_user[username] = (old_path, new_path)
        if re.fullmatch(r'(?:Test|Staging)?Host', username):
            hostnames.add(username)
    if len(hostnames) != 3 or len(by_user) != 45:
        raise ValueError('Expected three Hosts and 42 Creator/Joker accounts')

    lines = []
    current = None
    seen = set()
    for line in access.splitlines(keepends=True):
        if re.fullmatch(r'\[[A-Za-z0-9_]+\]\n', line):
            current = line[1:-2]
        if line.startswith(LINK_LABEL) and current in by_user:
            if current in seen:
                raise ValueError('Duplicate personal URL in access list')
            seen.add(current)
            old_path, new_path = by_user[current]
            old_url = urlsplit(line[len(LINK_LABEL):].rstrip('\n'))
            mapped = urlsplit(BASE + old_path)
            if ((old_url.scheme, old_url.netloc, old_url.path, old_url.query) !=
                    (mapped.scheme, mapped.netloc, mapped.path, mapped.query)):
                raise ValueError('Access list link differs from shortlink map')
            # Host long links retain their own TURN fragment.
            changed = revise(line[len(LINK_LABEL):].rstrip('\n'),
                             {**policy['accounts'][current], 'name': current},
                             policy['rooms'][policy['accounts'][current]['room']])
            if current not in hostnames:
                if changed != BASE + new_path:
                    raise ValueError('Creator/Joker long link differs from shortlink map')
            line = LINK_LABEL + changed + '\n'
        lines.append(line)
    if seen != set(by_user):
        raise ValueError('Missing personal URL in access list')

    output.mkdir(mode=0o700, parents=False)
    try:
        shortlinks_path = output / 'shortlinks.json'
        shortlinks_path.write_text(json.dumps({**original, 'links': updated}, separators=(',', ':')) + '\n')
        shortlinks_path.chmod(0o400)
        access_path = output / 'access-credentials.txt'
        access_path.write_text(''.join(lines))
        access_path.chmod(0o600)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged 45 Director-controlled mute URLs; all shortlink tokens and TURN fragments preserved.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: director-controlled-mute-links.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
