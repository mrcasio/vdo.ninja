#!/usr/bin/env python3
"""Reject deployment when runtime source differs from its published release."""
import hashlib,json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'source-release.json').read_text())
failed=[]
for name,digest in manifest['files'].items():
 p=root/name
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:failed.append(name)
if failed:
 print('Publish a matching source release before deploying. Changed files: '+', '.join(failed[:15]),file=sys.stderr);sys.exit(1)
print('Source release verified: '+manifest['source'])
