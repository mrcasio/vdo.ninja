#!/usr/bin/env python3
"""Stage the three existing Director links with show audio and room defaults.

Preserves every account, password, stream ID, co-director code and TURN key.
Writes only the replacement access list to a protected, new directory.
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


ROOMS = ('test', 'staging', 'production')
DEFAULTS = (
    ('autogain', '0'),
    ('echocancellation', '0'),
    ('denoise', '0'),
    ('totalroombitrate', '2000'),
)
PREFIX = 'Director-und-Rueckkanal-Link: '


def updated_link(link, room):
    url = urlsplit(link)
    if (url.scheme, url.netloc, url.path) != ('https', 'video.easy-cube.de', '/') or not url.fragment:
        raise ValueError('Unexpected Director link origin, path, or fragment')
    query = parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
    fields = dict(query)
    if len(query) != len(fields) or fields.get('director') != room['id'] or \
            fields.get('push') != room['returnStream']:
        raise ValueError('Director link differs from the room policy')
    old_keys = {'director', 'push'}
    new_keys = old_keys | dict(DEFAULTS).keys()
    if set(fields) == new_keys:
        if any(fields[key] != value for key, value in DEFAULTS):
            raise ValueError('Director link has conflicting defaults')
        return link
    if set(fields) != old_keys:
        raise ValueError('Director link has unexpected parameters')
    return urlunsplit(url._replace(query=urlencode(query + list(DEFAULTS))))


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: set-director-defaults.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    os.umask(0o077)
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    policy = json.loads((source / 'access-policy.json').read_text())
    if set(policy.get('rooms', {})) != set(ROOMS):
        raise RuntimeError('Expected the existing Test, Staging and Production rooms')

    lines = (source / 'access-credentials.txt').read_text().splitlines(keepends=True)
    current_account = None
    seen = set()
    rewritten = []
    for line in lines:
        if line.startswith('[') and line.rstrip('\n').endswith(']'):
            current_account = line.strip()[1:-1]
        if line.startswith(PREFIX):
            matches = [name for name in ROOMS if current_account == name.title() + 'Director']
            if len(matches) != 1 or matches[0] in seen:
                raise RuntimeError('Unexpected Director link section')
            name = matches[0]
            account = policy['accounts'].get(current_account, {})
            if account.get('role') != 'director' or account.get('room') != name or \
                    account.get('pushStream') != policy['rooms'][name]['returnStream']:
                raise RuntimeError('Director account differs from the room policy')
            rewritten.append(PREFIX + updated_link(line[len(PREFIX):].rstrip('\n'), policy['rooms'][name]) + '\n')
            seen.add(name)
        else:
            rewritten.append(line)
    if seen != set(ROOMS):
        raise RuntimeError('Expected exactly one Director link per room')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    (output / 'access-credentials.txt').write_text(''.join(rewritten))
    print('Staged three Director links; all other access-list entries are unchanged.')


if __name__ == '__main__':
    main()
