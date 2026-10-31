"""Derive the room ID VDO.Ninja sends to its signaling server."""

import hashlib
import json
import re
from pathlib import Path


def default_password(frontend_index: Path) -> str:
    source = frontend_index.read_text()
    matches = re.findall(r'^\s*session\.defaultPassword\s*=\s*("(?:[^"\\]|\\.)*")\s*;', source, re.MULTILINE)
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one literal VDO.Ninja default password')
    password = json.loads(matches[0])
    if not password:
        raise RuntimeError('The VDO.Ninja default password is empty')
    return password


def wire_room_id(room_id: str, password: str, hostname: str) -> str:
    if not room_id or not password or not hostname:
        raise RuntimeError('Cannot derive a wire room ID from empty input')
    return hashlib.sha256((room_id + password + hostname).encode()).hexdigest()[:16]


def wire_stream_suffix(password: str, hostname: str) -> str:
    if not password or not hostname:
        raise RuntimeError('Cannot derive a wire stream suffix from empty input')
    return hashlib.sha256((password + hostname).encode()).hexdigest()[:6]
