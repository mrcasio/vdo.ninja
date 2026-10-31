#!/usr/bin/env python3
"""Create a staged policy with VDO.Ninja's wire room IDs; never output secrets."""

import json
import os
import sys
from pathlib import Path

from room_wire_id import default_password, wire_room_id, wire_stream_suffix


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: add-wire-ids.py CURRENT_POLICY FRONTEND_INDEX OUTPUT_POLICY')
    source, frontend_index, output = map(Path, sys.argv[1:])
    policy = json.loads(source.read_text())
    if policy.get('version') != 2 or set(policy.get('rooms', {})) != {'test', 'staging', 'production'}:
        raise RuntimeError('Expected the existing three-room policy')
    password = default_password(frontend_index)
    ids = set()
    for room in policy['rooms'].values():
        if not isinstance(room.get('id'), str):
            raise RuntimeError('The policy contains an invalid room')
        expected = wire_room_id(room['id'], password, 'video.easy-cube.de')
        if room.get('wireId', expected) != expected:
            raise RuntimeError('The policy has an unexpected wire room ID')
        room['wireId'] = expected
        ids.add(room['wireId'])
    if len(ids) != 3:
        raise RuntimeError('Derived room IDs are not distinct')
    suffix = wire_stream_suffix(password, 'video.easy-cube.de')
    if policy.get('wireStreamSuffix', suffix) != suffix:
        raise RuntimeError('The policy has an unexpected wire stream suffix')
    policy['wireStreamSuffix'] = suffix
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(output, flags, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(policy, handle, separators=(',', ':'))
        handle.write('\n')
        handle.flush()
        source_stat = source.stat()
        os.fchown(handle.fileno(), source_stat.st_uid, source_stat.st_gid)
        os.fchmod(handle.fileno(), source_stat.st_mode & 0o777)
    print('Prepared room and stream wire IDs; credentials and links are unchanged.')


if __name__ == '__main__':
    main()
