#!/usr/bin/env python3
"""Stage Production as main director and three room-bound return co-directors.

Reads the current private policy and links. Writes replacement private files to a
new protected directory without printing credentials, stream IDs, or URL tokens.
"""

import json
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit


BASE = 'https://video.easy-cube.de'
ROOMS = ('test', 'staging', 'production')
OLD_NOTE = ('TestDirector, StagingDirector und ProductionDirector senden den Rueckkanal; '
            'Production ist nur Co-Director.')
NEW_NOTE = ('Production ist Haupt-Director; TestDirector, StagingDirector und '
            'ProductionDirector senden den Rueckkanal als Co-Directors.')
ACCOUNT_HEADING = re.compile(r'\[([A-Za-z0-9_]+)\]\n')
JOKER_NAME = re.compile(r'(?:Test|Staging)?JokerC[12]_0[1-6]')


def query_fields(link):
    url = urlsplit(link)
    if url.scheme not in ('', 'https') or url.netloc not in ('', 'video.easy-cube.de') or \
            url.path != '/' or not url.fragment:
        raise ValueError('Unexpected private link shape')
    pairs = parse_qsl(url.query, keep_blank_values=True)
    if len(pairs) != len(dict(pairs)):
        raise ValueError('Duplicate query parameter')
    return url, dict(pairs)


def checked_fragment(url, turn_key):
    pairs = parse_qsl(url.fragment.lstrip('?'), keep_blank_values=True)
    fields = dict(pairs)
    if len(pairs) != len(fields) or fields.get('turn') != 'twilio' or \
            fields.get('turnkey') != turn_key:
        raise ValueError('TURN fragment differs from the account key')
    code = fields.get('codirector')
    if code is not None and not re.fullmatch(r'[A-Za-z0-9]{28}', code):
        raise ValueError('Unexpected co-director code')
    if set(fields) != ({'turn', 'turnkey', 'codirector'} if code else {'turn', 'turnkey'}):
        raise ValueError('Unexpected URL fragment fields')
    return code


def encode_fields(pairs):
    return '&'.join(quote(key, safe='') if value == '' else
                    quote(key, safe='') + '=' + quote(value, safe='')
                    for key, value in pairs)


def replace_query(url, pairs):
    return urlunsplit(url._replace(query=encode_fields(pairs)))


def updated_broadcast(link, account, room, turn_key):
    url, fields = query_fields(link)
    expected = {'room': room['id'], 'push': account['pushStream'],
                'label': account['label'], 'broadcast': '', 'audiogain': '0'}
    if account['role'] == 'guest':
        expected['nomicbutton'] = ''
    if fields != expected or len(fields) != len(expected) or \
            checked_fragment(url, turn_key) is not None:
        raise ValueError('Participant link differs from current policy')
    old = '&broadcast=&'
    if url.query.count(old) != 1:
        raise ValueError('Expected one blank broadcast flag')
    return urlunsplit(url._replace(query=url.query.replace(
        old, '&broadcast=' + quote(room['returnStream'], safe='') + '&', 1)))


def main(source, output):
    os.umask(0o077)
    if output.exists():
        raise FileExistsError(output)
    policy = json.loads((source / 'access-policy.json').read_text())
    shortlinks = json.loads((source / 'shortlinks.json').read_text())
    access = (source / 'access-credentials.txt').read_text()
    turn_keys = dict(line.split(maxsplit=1) for line in
                     (source / 'turn-keys.txt').read_text().splitlines())
    if policy.get('version') != 3 or set(policy.get('rooms', {})) != set(ROOMS) or \
            len(policy.get('accounts', {})) != 52 or \
            shortlinks.get('version') != 1 or len(shortlinks.get('links', {})) != 45 or \
            set(turn_keys) != set(policy['accounts']) or access.count(OLD_NOTE) != 1:
        raise ValueError('Expected the current 52-account, 45-shortlink configuration')
    accounts = policy['accounts']
    if accounts.get('Production') != {'role': 'codirector'}:
        raise ValueError('Production account has unexpected policy')
    for name in ROOMS:
        username = name.title() + 'Director'
        if accounts.get(username) != {'role': 'director', 'room': name,
                                     'pushStream': policy['rooms'][name]['returnStream']}:
            raise ValueError('Room Director account has unexpected policy')

    lines = access.replace(OLD_NOTE, NEW_NOTE).splitlines(keepends=True)
    positions = {}
    current = None
    for index, line in enumerate(lines):
        heading = ACCOUNT_HEADING.fullmatch(line)
        if heading:
            current = heading.group(1)
        if ': ' in line and current:
            label = line.split(': ', 1)[0]
            key = (current, label)
            if key in positions:
                raise ValueError('Duplicate access-list field')
            positions[key] = index

    codes = {}
    production_updates = {}
    publisher_updates = {}
    for name in ROOMS:
        title = name.title()
        room = policy['rooms'][name]
        production_label = 'Co-Director ' + title
        publisher = title + 'Director'
        production_index = positions[('Production', production_label)]
        publisher_index = positions[(publisher, 'Director-und-Rueckkanal-Link')]
        production_url, production_fields = query_fields(
            lines[production_index].split(': ', 1)[1].rstrip('\n'))
        publisher_url, publisher_fields = query_fields(
            lines[publisher_index].split(': ', 1)[1].rstrip('\n'))
        if production_fields != {'director': room['id'], 'noclaim': '', 'nopush': ''}:
            raise ValueError('Production link differs from current co-director policy')
        if publisher_fields != {'director': room['id'], 'push': room['returnStream'],
                                'autogain': '0', 'echocancellation': '0',
                                'denoise': '0', 'totalroombitrate': '2000'}:
            raise ValueError('Return publisher link differs from current Director policy')
        code = checked_fragment(production_url, turn_keys['Production'])
        if not code or checked_fragment(publisher_url, turn_keys[publisher]) != code:
            raise ValueError('Co-director code does not match within the room')
        codes[name] = code
        production_updates[production_index] = ('Haupt-Director ' + title + ': ' +
            replace_query(production_url, [('director', room['id']), ('nopush', ''),
                                           ('totalroombitrate', '2000')]) + '\n')
        publisher_link = replace_query(publisher_url, [
            ('director', room['id']), ('noclaim', ''), ('push', room['returnStream']),
            ('autogain', '0'), ('echocancellation', '0'), ('denoise', '0')])
        publisher_updates[publisher_index] = publisher_link

    new_links = {}
    participant_paths = {}
    for token, entry in shortlinks['links'].items():
        username = entry.get('username')
        account = accounts.get(username, {})
        if not re.fullmatch(r'[A-Za-z0-9_-]{22}', token) or \
                account.get('role') not in ('participant', 'creator', 'guest') or \
                username in participant_paths or not isinstance(entry.get('path'), str):
            raise ValueError('Unexpected participant shortlink')
        room = policy['rooms'][account['room']]
        if account['role'] == 'guest' and not JOKER_NAME.fullmatch(username):
            raise ValueError('Unexpected Joker name')
        changed = updated_broadcast(entry['path'], account, room, turn_keys[username])
        new_links[token] = {**entry, 'path': changed}
        participant_paths[username] = (entry['path'], changed)
    if len(participant_paths) != 45 or \
            sum(accounts[name]['role'] == 'guest' for name in participant_paths) != 36:
        raise ValueError('Expected 45 participants and 36 Jokers')

    updated_lines = []
    current = None
    seen_participants = set()
    for index, line in enumerate(lines):
        heading = ACCOUNT_HEADING.fullmatch(line)
        if heading:
            current = heading.group(1)
        if index in production_updates:
            line = production_updates[index]
        elif index in publisher_updates:
            publisher = current
            link = publisher_updates[index]
            token = secrets.token_urlsafe(16)
            while token in new_links:
                token = secrets.token_urlsafe(16)
            new_links[token] = {'username': publisher, 'path': link.removeprefix(BASE)}
            line = ('Co-Director-und-Rueckkanal-Link: ' + link + '\n' +
                    'Kurzlink: ' + BASE + '/l/' + token + '\n')
        elif line.startswith('Kamera-und-Rueckkanal-Link: ') and current in participant_paths:
            if current in seen_participants:
                raise ValueError('Duplicate participant link in access list')
            original_link = line.split(': ', 1)[1].rstrip('\n')
            old_path, _ = participant_paths[current]
            if urlsplit(original_link).query != urlsplit(old_path).query:
                raise ValueError('Access-list query differs from shortlink map')
            account = accounts[current]
            room = policy['rooms'][account['room']]
            changed = updated_broadcast(original_link, account, room, turn_keys[current])
            line = 'Kamera-und-Rueckkanal-Link: ' + changed + '\n'
            seen_participants.add(current)
        updated_lines.append(line)
    if seen_participants != set(participant_paths) or len(new_links) != 48 or \
            len(production_updates) != 3 or len(publisher_updates) != 3:
        raise ValueError('Incomplete link migration')

    accounts['Production'] = {'role': 'director', 'rooms': list(ROOMS)}
    for name in ROOMS:
        accounts[name.title() + 'Director']['role'] = 'codirector'
    policy['version'] = 4
    output.mkdir(mode=0o700, parents=False)
    try:
        files = {
            'access-policy.json': (json.dumps(policy, separators=(',', ':')) + '\n', 0o400),
            'shortlinks.json': (json.dumps({**shortlinks, 'links': new_links},
                                           separators=(',', ':')) + '\n', 0o400),
            'access-credentials.txt': (''.join(updated_lines), 0o600),
        }
        for filename, (contents, mode) in files.items():
            target = output / filename
            target.write_text(contents)
            target.chmod(mode)
    except BaseException:
        for path in output.iterdir():
            path.unlink()
        output.rmdir()
        raise
    print('Staged Production main Director for three rooms, three return co-directors, '
          'three new shortlinks and 45 fixed broadcast links.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: invert-director-roles.py SOURCE_SECRETS_DIR NEW_OUTPUT_DIR')
    main(Path(sys.argv[1]), Path(sys.argv[2]))
