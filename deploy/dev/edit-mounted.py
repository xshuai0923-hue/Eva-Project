#!/usr/bin/env python3
"""Rewrite a file in place, keeping its inode.

The two .rb files under deploy/openproject are single-file Docker bind mounts. A normal
editor — or `sed -i` on macOS — writes a temporary file and renames it over the original,
which allocates a NEW inode; the mount keeps pointing at the old one, now unlinked, and
the container gets `No such file` from then on while `ls` still lists it. Opening the
file and truncating it keeps the inode, so the container keeps reading the same file.

Usage: edit-mounted.py <path> <old> <new>
"""
import sys

path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r+", encoding="utf-8") as handle:
    text = handle.read()
    if old not in text:
        raise SystemExit(f"not found in {path}: {old!r}")
    handle.seek(0)
    handle.write(text.replace(old, new))
    handle.truncate()
print(f"{path}: {old} -> {new}")
