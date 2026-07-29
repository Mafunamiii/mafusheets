#!/usr/bin/env python3
"""Small, dependency-free MafuSheets bundle verification helpers."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import tarfile
import re

FORMAT = "mafusheets-backup"
FORMAT_VERSION = 2


class BackupError(Exception):
    pass


def _safe_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name.removeprefix("./"))
    if not name or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise BackupError(f"unsafe bundle path: {name!r}")
    return path


def extract_bundle(bundle: Path, destination: Path, max_bytes: int) -> None:
    """Extract regular files only, without trusting tar paths or metadata."""
    total = 0
    seen: set[str] = set()
    destination.mkdir(mode=0o700)
    with tarfile.open(bundle, mode="r:*") as archive:
        for member in archive:
            relative = _safe_name(member.name)
            key = relative.as_posix()
            if key in seen:
                raise BackupError(f"duplicate bundle entry: {key}")
            seen.add(key)
            if member.isdir():
                continue
            if not member.isfile():
                raise BackupError(f"non-regular bundle entry: {key}")
            total += member.size
            if total > max_bytes:
                raise BackupError("bundle exceeds extraction limit")
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise BackupError(f"cannot read bundle entry: {key}")
            with target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o600)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_tree(source: Path) -> dict:
    """Verify manifest inventory, SHA-256 values, and SQLite integrity read-only."""
    try:
        manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BackupError(f"invalid manifest: {error}") from error
    if manifest.get("format") != FORMAT or manifest.get("formatVersion") != FORMAT_VERSION:
        raise BackupError("unsupported backup format")
    if not isinstance(manifest.get("bundleId"), str) or not isinstance(manifest.get("files"), list):
        raise BackupError("invalid manifest fields")

    expected = {"manifest.json"}
    for item in manifest["files"]:
        if not isinstance(item, dict) or not {"path", "size", "sha256"} <= set(item):
            raise BackupError("invalid manifest file entry")
        if (not isinstance(item["path"], str) or
                not isinstance(item["size"], int) or isinstance(item["size"], bool) or
                item["size"] < 0 or
                not isinstance(item["sha256"], str) or
                not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
            raise BackupError("invalid manifest file values")
        relative = _safe_name(item["path"])
        key = relative.as_posix()
        if key != "database.sqlite" and not key.startswith("uploads/"):
            raise BackupError(f"unexpected manifest path: {key}")
        if key in expected:
            raise BackupError(f"duplicate manifest path: {key}")
        expected.add(key)
        path = source.joinpath(*relative.parts)
        try:
            metadata = path.lstat()
        except OSError as error:
            raise BackupError(f"missing file: {key}") from error
        if not stat.S_ISREG(metadata.st_mode):
            raise BackupError(f"non-regular file: {key}")
        if metadata.st_size != item["size"]:
            raise BackupError(f"incorrect size: {key}")
        if _sha256(path) != item["sha256"]:
            raise BackupError(f"incorrect SHA-256: {key}")

    actual = {
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file()
    }
    if actual != expected:
        raise BackupError(f"bundle inventory mismatch: unexpected={sorted(actual - expected)}")

    database = source / "database.sqlite"
    if "database.sqlite" not in expected:
        raise BackupError("manifest does not contain database.sqlite")
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro&immutable=1", uri=True)
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        connection.close()
    except sqlite3.Error as error:
        raise BackupError(f"SQLite verification failed: {error}") from error
    if integrity != [("ok",)]:
        raise BackupError(f"SQLite integrity_check failed: {integrity[:3]}")
    return manifest


def make_root_owned_read_only(path: Path) -> None:
    owner = 0 if os.geteuid() == 0 else os.geteuid()
    group = 0 if os.geteuid() == 0 else os.getegid()
    for current, directories, files in os.walk(path):
        os.chown(current, owner, group)
        os.chmod(current, 0o500)
        for name in directories:
            os.chown(Path(current) / name, owner, group)
        for name in files:
            item = Path(current) / name
            os.chown(item, owner, group)
            os.chmod(item, 0o400)
