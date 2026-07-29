#!/usr/bin/env python3
"""Root-side receiver: detach, verify, archive, or quarantine complete bundles."""

import argparse
import fcntl
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

from mafusheets_backup import BackupError, extract_bundle, make_root_owned_read_only, verify_tree

BUNDLE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{24}\.bundle$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--incoming", type=Path, default=Path("/var/spool/mafusheets-backup/incoming"))
    parser.add_argument("--work", type=Path, default=Path("/var/lib/mafusheets-backup/work"))
    parser.add_argument("--archive", type=Path, default=Path("/srv/backups/mafusheets/archive"))
    parser.add_argument("--quarantine", type=Path, default=Path("/srv/backups/mafusheets/quarantine"))
    parser.add_argument("--max-bytes", type=int, default=20 * 1024**3)
    args = parser.parse_args()

    args.work.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (args.work / ".receiver.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0

    for uploaded in sorted(args.incoming.glob("*.bundle")):
        if not BUNDLE.fullmatch(uploaded.name) or uploaded.is_symlink() or not uploaded.is_file():
            continue
        detached = args.work / uploaded.name
        try:
            uploaded.rename(detached)
        except FileNotFoundError:
            continue
        bundle_id = uploaded.name.removesuffix(".bundle")
        extracted = Path(tempfile.mkdtemp(prefix=f"{bundle_id}.", dir=args.work))
        extracted.rmdir()
        try:
            extract_bundle(detached, extracted, args.max_bytes)
            manifest = verify_tree(extracted)
            if manifest["bundleId"] != bundle_id:
                raise BackupError("bundle filename and manifest ID differ")
            destination = args.archive / bundle_id
            if destination.exists():
                raise BackupError("archive entry already exists")
            extracted.rename(destination)
            make_root_owned_read_only(destination)
            detached.unlink()
            print(json.dumps({"status": "archived", "bundleId": bundle_id}))
        except Exception as error:
            quarantine = args.quarantine / uploaded.name
            if quarantine.exists():
                quarantine = args.quarantine / f"{uploaded.name}.duplicate"
            detached.rename(quarantine)
            (args.quarantine / f"{quarantine.name}.reason").write_text(
                f"{type(error).__name__}: {error}\n", encoding="utf-8"
            )
            shutil.rmtree(extracted, ignore_errors=True)
            print(json.dumps({"status": "quarantined", "bundleId": bundle_id,
                              "reason": str(error)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
