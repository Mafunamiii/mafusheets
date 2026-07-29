# MafuSheets restore runbook

The archive stores already-extracted, verified directories. A working MafuSheets installation is
not needed to validate or copy one.

1. On a Debian recovery host, install `python3` and copy the root-owned
   `mafusheets_backup.py` and `mafusheets-backup-restore` tools from the HomeServer.
2. Choose an archive entry and an absent destination:

   ```sh
   sudo python3 /usr/local/libexec/mafusheets-backup-restore \
     --source /srv/backups/mafusheets/archive/BUNDLE_ID \
     --destination /srv/mafusheets-restore
   ```

3. Expect JSON with `"ok": true`. The tool rechecks every SHA-256 digest and SQLite
   `integrity_check` before copying.
4. Install the application version identified by `applicationCommit`/`imageDigest` in the
   manifest. Put `database.sqlite` and `uploads/` in its documented data paths while it is stopped.
5. Restore production secrets separately; backup bundles intentionally contain no secrets.
6. Start the application on an isolated interface, test login and representative documents, then
   take a fresh backup before reopening service.

Integration rehearsal:

```sh
npm run test:offsite-backup
```

The test suite creates a real SQLite backup, processes it through the receiver, restores the
root-owned archive, and re-verifies its contents.
