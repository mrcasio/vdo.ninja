#!/usr/bin/env python3
"""Create a new private password-export key without printing it or replacing an existing key."""
import argparse, os, secrets
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('new_output_file', type=Path)
args = parser.parse_args()
descriptor = os.open(args.new_output_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
with os.fdopen(descriptor, 'w') as stream:
    stream.write(secrets.token_hex(32) + '\n')
    stream.flush()
    os.fsync(stream.fileno())
print('Created a private 256-bit password-export key. No credential or account was changed.')
