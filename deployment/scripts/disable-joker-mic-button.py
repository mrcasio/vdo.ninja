#!/usr/bin/env python3
"""Stage Joker links without a local mic button, preserving every token and secret."""

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit


BASE = 'https://video.easy-cube.de'
LINK_LABEL = 'Kamera-und-Rueckkanal-Link: '
EXPECTED_FIELDS = {'room', 'push', 'label', 'broadcast', 'audiogain'}
JOKER_NAME = re.compile(r'(?:Test|Staging)?JokerC[12]_0[1-6]')


def add_nomicbutton(link, account, room):
    url = urlsplit(link)
    pairs = parse_qsl(url.query, keep_blank_values=True)
    fields = dict(pairs)
    if (url.scheme not in ('', 'https') or url.netloc not in ('', 'video.easy-cube.de') or
            url.path != '/' or not url.fragment or len(pairs) != len(EXPECTED_FIELDS) or
            set(fields) != EXPECTED_FIELDS or fields['room'] != room['id'] or
            fields['push'] != account['pushStream'] or fields['label'] != account['label'] or
            fields['broadcast'] != '' or fields['audiogain'] != '0'):
        raise ValueError('Joker link differs from the current room policy')
    return urlunsplit(url._replace(query=url.query + '&nomicbutton'))


def main(source, output):
    os.umask(0o077)
    if output.exists():
        raise FileExistsError(output)
    policy = json.loads((source / 'access-policy.json').read_text())
    shortlinks = json.loads((source / 'shortlinks.json').read_text())
    access = (source / 'access-credentials.txt').read_text()
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != {'test', 'staging', 'production'}:
        raise ValueError('Expected current three-room policy')
    if shortlinks.get('version') != 1 or len(shortlinks.get('links', {})) != 45:
        raise ValueError('Expected 45 personal shortlinks')

    updated_links = {}
    joker_paths = {}
    names = set()
    for token, entry in shortlinks['links'].items():
        name = entry.get('username')
        account = policy['accounts'].get(name, {})
        if not re.fullmatch(r'[A-Za-z0-9_-]{22}', token) or not isinstance(entry.get('path'), str):
            raise ValueError('Invalid shortlink token or path')
        if account.get('role') == 'guest':
            if not JOKER_NAME.fullmatch(name) or name in names:
                raise ValueError('Unexpected Joker account')
            old_path = entry['path']
            room = policy['rooms'][account['room']]
            new_path = add_nomicbutton(old_path, account, room)
            updated_links[token] = {**entry, 'path': new_path}
            joker_paths[name] = (old_path, new_path)
            names.add(name)
        else:
            if account.get('role') not in ('participant', 'creator'):
                raise ValueError('Unexpected non-Joker shortlink account')
            updated_links[token] = entry
    if len(joker_paths) != 36 or len(updated_links) != 45:
        raise ValueError('Expected 36 distinct Joker links and nine other links')

    current = None
    seen = set()
    changed_lines = []
    for line in access.splitlines(keepends=True):
        if re.fullmatch(r'\[[A-Za-z0-9_]+\]\n', line):
            current = line[1:-2]
        if line.startswith(LINK_LABEL) and current in joker_paths:
            if current in seen:
                raise ValueError('Duplicate Joker link in access list')
            old_path, new_path = joker_paths[current]
            old_url = line[len(LINK_LABEL):].rstrip('\n')
            if old_url != BASE + old_path:
                raise ValueError('Joker access-list link differs from shortlink map')
            line = LINK_LABEL + BASE + new_path + '\n'
            seen.add(current)
        changed_lines.append(line)
    if seen != set(joker_paths):
        raise ValueError('Missing Joker link in access list')

    output.mkdir(mode=0o700, parents=False)
    try:
        shortlink_file = output / 'shortlinks.json'
        shortlink_file.write_text(json.dumps({**shortlinks, 'links': updated_links}, separators=(',', ':')) + '\n')
        shortlink_file.chmod(0o400)
        access_file = output / 'access-credentials.txt'
        access_file.write_text(''.join(changed_lines))
        access_file.chmod(0o600)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged 36 Joker links; other links, shortlink tokens and TURN fragments preserved.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: disable-joker-mic-button.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
