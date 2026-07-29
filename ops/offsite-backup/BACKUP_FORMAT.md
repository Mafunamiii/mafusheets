# MafuSheets small-system backup format

A `.bundle` is a POSIX tar archive containing regular files only:

- `manifest.json`
- `database.sqlite`
- zero or more regular files below `uploads/`

The current manifest uses `format: "mafusheets-backup"` and `formatVersion: 2`. Its `files` array
lists every file except the manifest with `path`, byte `size`, and lowercase SHA-256 digest.
Additional informational fields produced by MafuSheets are allowed. The bundle filename is
`<bundleId>.bundle`, where the ID is a UTC timestamp and 24 random hexadecimal characters.

The HomeServer treats the tar as untrusted: absolute/traversal paths, duplicate entries, links,
devices, FIFOs, sockets, unexpected files, inventory differences, size differences, checksum
differences, and a failed SQLite `PRAGMA integrity_check` are rejected. Tar ownership, modes, ACLs,
and extended attributes are never restored. This small-system receiver supports format version 2;
schema-specific application validation is deliberately deferred.
